import { randomUUID } from "node:crypto"
import type { AdminIdentity } from "toy-admin-auth"
import { RelationalError } from "toy-storage-relational"
import type { AdminAudit, AuditCall } from "./audit.js"
import type { ResolvedAdminConfig } from "./config.js"
import { AdminError, normalizeError } from "./error.js"
import type { Inflight, Invocation } from "./inflight.js"
import type { OperationRegistry, RegisteredOperation } from "./registry.js"
import type { AdminExecuteOptions, AdminExecutionContext } from "./types.js"
import { freezeDeep, jsonSnapshot, objectInput, text } from "./validation.js"

/**
 * 协议无关执行管线。独立观察完整业务 Promise，等待超时不会释放仍在运行的容量。
 * authenticate 由拥有身份数据的插件提供，不能用客户端 identity 直接调用执行函数。
 */
export class ExecutionEngine {
  constructor(
    private readonly registry: OperationRegistry,
    readonly inflight: Inflight,
    private readonly audit: AdminAudit,
    private readonly config: ResolvedAdminConfig,
    private readonly authenticate: (token: string) => Promise<AdminIdentity>,
    private readonly now: () => string,
    private readonly lateFailure: (id: string, code: string) => void,
  ) {}

  /** 输入为业务 DTO；返回 O 或原始 opaque 句柄，不编码 HTTP、不消费事件源。 */
  async execute<I, O>(name: string, options: AdminExecuteOptions<I>): Promise<O> {
    const id = randomUUID()
    const call: AuditCall = {
      executionId: id,
      requestId: id,
      operationName:
        typeof name === "string" && /^[a-zA-Z][a-zA-Z0-9_.-]{0,127}$/.test(name)
          ? name
          : "<invalid>",
      startedAt: this.now(),
      startedClock: performance.now(),
      summary: null,
    }
    let invocation: Invocation | undefined
    try {
      objectInput(options)
      const operationName = text(name, "name")
      if (!/^[a-zA-Z][a-zA-Z0-9_-]*(?:\.[a-zA-Z0-9_-]+)*$/.test(operationName)) {
        throw new AdminError("invalid-input", "管理能力名称格式不合法")
      }
      call.operationName = operationName
      if (options.requestId !== undefined) {
        call.requestId = text(options.requestId, "requestId")
      }
      if (options.expectedRegistrationId !== undefined) {
        text(options.expectedRegistrationId, "expectedRegistrationId")
      }
      if (options.signal !== undefined && !(options.signal instanceof AbortSignal)) {
        throw new AdminError("invalid-input", "signal 必须是 AbortSignal")
      }
      invocation = this.inflight.create(
        id,
        this.registry.get(operationName)?.description.timeoutMs ?? this.config.defaultTimeoutMs,
        options.signal,
      )
      const current = invocation
      // 将 finally 的 Promise 交给 wait，超时后仍有 rejection handler 观察其最终结果。
      // 固定凭据和选项，避免异步前置检查期间调用方替换 Token/DTO 引用。
      const captured = { ...options }
      const work = this.run(call, operationName, captured, current).finally(() =>
        this.inflight.release(current),
      )
      void work.catch((error: unknown) => {
        if (current.waitStatus === "timeout" || current.waitStatus === "cancelled") {
          this.lateFailure(id, error instanceof AdminError ? error.code : "execution-failed")
        }
      })
      return (await current.wait(work)) as O
    } catch (error) {
      if (invocation !== undefined) {
        throw error
      }
      const rejected = normalizeError(error, id, "not-started")
      try {
        await this.audit.reject(call, rejected.code, "completed")
      } catch (cause) {
        throw new AdminError("audit-unavailable", "调用未执行，无法确认拒绝审计已保存", {
          executionId: id,
          cause,
        })
      }
      throw rejected
    }
  }

  private async run<I>(
    call: AuditCall,
    name: string,
    options: AdminExecuteOptions<I>,
    invocation: Invocation,
  ): Promise<unknown> {
    let auditStarted = false
    let startAttempted = false
    let failure: AdminError | undefined
    let result: unknown
    try {
      invocation.check()
      call.identity = await this.authenticate(options.token)
      invocation.check()
      const entry = this.lookup(name, options.expectedRegistrationId)
      this.checkRole(entry, call.identity)
      call.description = entry.description
      invocation.follow(entry.controller.signal)
      const input = jsonSnapshot(options.input, this.config.maxDataBytes, "invalid-input")
      if (!entry.input(input)) {
        throw new AdminError("invalid-input", "输入未通过管理能力 Schema 校验")
      }
      let context = this.context(call, invocation)
      if (entry.authorize !== undefined) {
        const allowed = await entry.authorize(input, context)
        if (allowed !== undefined && allowed !== true) {
          throw new AdminError("forbidden", "目标资源检查拒绝访问")
        }
      }
      invocation.check()
      if (entry.audit !== undefined) {
        call.summary = this.audit.safeSummary(
          await entry.audit(input, context),
          this.config.maxAuditBytes,
        )
      }
      invocation.check()
      startAttempted = true
      await this.audit.start(call)
      auditStarted = true
      // 前置授权或审计可能等待数据库；提交业务前重新认证，防止期间降级/强制下线。
      call.identity = await this.authenticate(options.token)
      this.checkRole(entry, call.identity)
      this.lookup(name, entry.description.registrationId)
      invocation.check()
      context = this.context(call, invocation)
      invocation.executionState = "unknown"
      try {
        result = await entry.execute(input, context)
        invocation.executionState = "succeeded"
      } catch (error) {
        invocation.executionState =
          (error instanceof RelationalError && error.unknownState) ||
          (error instanceof AdminError && error.executionState === "unknown")
            ? "unknown"
            : "failed"
        throw error
      }
      if (entry.description.resultKind === "value") {
        result = jsonSnapshot(
          result === undefined ? null : result,
          this.config.maxDataBytes,
          "invalid-output",
        )
        if (entry.output !== undefined && !entry.output(result)) {
          throw new AdminError("invalid-output", "结果未通过管理能力 Schema 校验，业务可能已执行")
        }
      }
    } catch (error) {
      failure = normalizeError(error, call.executionId, invocation.executionState)
    }

    // 审计收尾位于业务 catch 之外，避免把审计失败再次当成业务失败或二次执行。
    try {
      const wait = invocation.waitStatus === "waiting" ? "completed" : invocation.waitStatus
      if (auditStarted) {
        await this.audit.finish(call, invocation.executionState, wait, failure?.code ?? null)
        if (invocation.waitStatus !== "waiting" && invocation.waitStatus !== wait) {
          await this.audit.finish(
            call,
            invocation.executionState,
            invocation.waitStatus,
            failure?.code ?? null,
          )
        }
      } else if (!startAttempted) {
        await this.audit.reject(call, failure?.code ?? "execution-failed", wait)
      } else {
        throw failure
      }
    } catch (cause) {
      throw new AdminError(
        auditStarted ? "audit-incomplete" : "audit-unavailable",
        auditStarted
          ? "管理调用已结束，但无法确认结束审计已保存；请核对执行状态后再决定是否重试"
          : "管理调用未执行，无法确认开始或拒绝审计已保存",
        { executionId: call.executionId, executionState: invocation.executionState, cause },
      )
    }
    if (failure !== undefined) {
      throw failure
    }
    return result
  }

  private lookup(name: string, expected?: string): RegisteredOperation {
    const entry = this.registry.get(name)
    if (entry === undefined) {
      throw new AdminError("operation-not-found", "管理能力不存在或已注销")
    }
    if (expected !== undefined && entry.description.registrationId !== expected) {
      throw new AdminError("operation-unavailable", "管理能力注册代次已变化")
    }
    return entry
  }

  private checkRole(entry: RegisteredOperation, identity: AdminIdentity): void {
    if (!entry.description.roles.includes(identity.admin.role)) {
      throw new AdminError("forbidden", "当前角色无权调用该管理能力")
    }
  }

  private context(call: AuditCall, invocation: Invocation): AdminExecutionContext {
    return Object.freeze({
      executionId: call.executionId,
      requestId: call.requestId,
      operationName: call.operationName,
      identity: freezeDeep(structuredClone(call.identity!)),
      signal: invocation.controller.signal,
    })
  }
}
