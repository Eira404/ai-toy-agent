import { randomUUID } from "node:crypto"
import type { ValidateFunction } from "ajv"
import type { AdminRole } from "toy-admin-auth"
import { AdminError } from "./error.js"
import type { ResolvedAdminConfig } from "./config.js"
import type {
  AdminBinding,
  AdminExecutionContext,
  AdminOperationDefinition,
  AdminOperationDescription,
  AdminRegistrySnapshot,
} from "./types.js"
import {
  compileSchema,
  freezeDeep,
  jsonSnapshot,
  objectInput,
  positive,
  text,
} from "./validation.js"

/** 内部执行项不进入能力快照；controller 只影响尚未返回的 execute。 */
export interface RegisteredOperation {
  readonly description: AdminOperationDescription
  readonly input: ValidateFunction
  readonly output: ValidateFunction | undefined
  readonly controller: AbortController
  readonly execute: (input: unknown, context: AdminExecutionContext) => unknown
  readonly authorize: ((input: unknown, context: AdminExecutionContext) => unknown) | undefined
  readonly audit: ((input: unknown, context: AdminExecutionContext) => unknown) | undefined
}

const validRole = (value: unknown): value is AdminRole =>
  value === "superadmin" || value === "admin" || value === "viewer"

/**
 * 纯能力注册表，不解释绑定中的 URL/协议，不持有数据库或身份。
 * 每个注册项都有唯一代次；注销只删除对应项，避免旧 disposer 删除新项。
 */
export class OperationRegistry {
  private readonly entries = new Map<string, RegisteredOperation>()
  private revision = 0
  private closed = false

  constructor(
    private readonly config: ResolvedAdminConfig,
    private readonly changed: (snapshot: AdminRegistrySnapshot) => void,
  ) {}

  /** 所有校验/编译成功后一次发布；失败时不会改变注册表。 */
  register<I, O>(definition: AdminOperationDefinition<I, O>): () => void {
    if (this.closed) {
      throw new AdminError("operation-unavailable", "管理员注册表已关闭")
    }
    objectInput(definition, "invalid-definition")
    const name = text(definition.name, "name", "invalid-definition")
    if (!/^[a-zA-Z][a-zA-Z0-9_-]*(?:\.[a-zA-Z0-9_-]+)*$/.test(name)) {
      throw new AdminError("invalid-definition", "管理能力名称格式不合法")
    }
    if (this.entries.has(name)) {
      throw new AdminError("duplicate-operation", "管理能力名称已注册")
    }
    if (
      !Array.isArray(definition.roles) ||
      definition.roles.length === 0 ||
      !definition.roles.every(validRole)
    ) {
      throw new AdminError("invalid-definition", "roles 必须是非空管理员角色列表")
    }
    if (definition.kind !== "query" && definition.kind !== "command") {
      throw new AdminError("invalid-definition", "kind 必须是 query 或 command")
    }
    if (definition.kind === "command" && definition.roles.includes("viewer")) {
      throw new AdminError("invalid-definition", "业务 command 不可授予 viewer")
    }
    if (
      typeof definition.execute !== "function" ||
      (definition.authorize !== undefined && typeof definition.authorize !== "function") ||
      (definition.audit !== undefined && typeof definition.audit !== "function")
    ) {
      throw new AdminError("invalid-definition", "管理能力回调格式不合法")
    }
    const resultKind = definition.resultKind ?? "value"
    if (
      (resultKind !== "value" && resultKind !== "opaque") ||
      (resultKind === "opaque" && definition.output !== undefined)
    ) {
      throw new AdminError("invalid-definition", "不透明结果不能指定普通输出 Schema")
    }
    const timeoutMs = positive(definition.timeoutMs ?? this.config.defaultTimeoutMs, "timeoutMs")
    if (timeoutMs > this.config.maxTimeoutMs) {
      throw new AdminError("invalid-definition", "操作等待期限超过配置上限")
    }
    const bindings = jsonSnapshot(
      definition.bindings,
      this.config.maxDefinitionBytes,
      "invalid-definition",
    )
    if (
      !Array.isArray(bindings) ||
      bindings.length === 0 ||
      !bindings.every(
        (binding) =>
          binding !== null &&
          typeof binding === "object" &&
          !Array.isArray(binding) &&
          typeof binding.transport === "string" &&
          binding.transport.trim().length > 0,
      )
    ) {
      throw new AdminError(
        "invalid-definition",
        "bindings 必须包含至少一个带 transport 的 JSON 对象",
      )
    }
    const input = compileSchema(definition.input, this.config.maxDefinitionBytes)
    const output =
      definition.output === undefined
        ? undefined
        : compileSchema(definition.output, this.config.maxDefinitionBytes)
    const description: AdminOperationDescription = freezeDeep({
      registrationId: randomUUID(),
      name,
      description: text(definition.description, "description", "invalid-definition", 2000),
      roles: [...new Set(definition.roles)],
      kind: definition.kind,
      bindings: bindings as unknown as readonly AdminBinding[],
      input: input.schema,
      ...(output === undefined ? {} : { output: output.schema }),
      resultKind,
      timeoutMs,
    })
    // 捕获注册时的函数，不允许调用方之后替换 definition.execute 改变已注册能力。
    const execute = definition.execute.bind(definition)
    const authorize = definition.authorize?.bind(definition)
    const audit = definition.audit?.bind(definition)
    const entry: RegisteredOperation = {
      description,
      input: input.validate,
      output: output?.validate,
      controller: new AbortController(),
      execute: (value, context) => execute(value as I, context),
      authorize:
        authorize === undefined ? undefined : (value, context) => authorize(value as I, context),
      audit: audit === undefined ? undefined : (value, context) => audit(value as I, context),
    }
    this.entries.set(name, entry)
    this.publish()
    return () => {
      if (this.entries.get(name) === entry) {
        this.entries.delete(name)
        entry.controller.abort(new AdminError("operation-unavailable", "管理能力已注销"))
        this.publish()
      }
    }
  }

  get(name: string): RegisteredOperation | undefined {
    return this.entries.get(name)
  }

  /** 快照仅包含冻结的可序列化描述，不暴露执行函数或取消控制器。 */
  snapshot(): AdminRegistrySnapshot {
    return freezeDeep({
      revision: this.revision,
      operations: [...this.entries.values()]
        .map((entry) => entry.description)
        .sort((a, b) => a.name.localeCompare(b.name)),
    })
  }

  close(): void {
    this.closed = true
    for (const entry of this.entries.values()) {
      entry.controller.abort(new AdminError("operation-unavailable", "管理员插件已卸载"))
    }
    this.entries.clear()
    this.publish()
  }

  private publish(): void {
    this.revision += 1
    this.changed(this.snapshot())
  }
}
