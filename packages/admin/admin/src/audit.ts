import type { AdminIdentity } from "toy-admin-auth"
import type { JsonValue, RelationalAdapter, RelationalRecord } from "toy-storage-relational"
import { AdminError } from "./error.js"
import { adminRelationalSchema, ADMIN_OPERATIONS_TABLE } from "./schema.js"
import type { AdminExecutionState, AdminOperationDescription, AdminWaitStatus } from "./types.js"
import { jsonSnapshot } from "./validation.js"

/** 单次调用的元数据，只保存标识和安全摘要，不保存 Token、完整输入或结果。 */
export interface AuditCall {
  readonly executionId: string
  requestId: string
  operationName: string
  readonly startedAt: string
  readonly startedClock: number
  identity?: AdminIdentity
  description?: AdminOperationDescription
  summary: JsonValue
}

function hasSensitiveKey(value: JsonValue): boolean {
  if (value === null || typeof value !== "object") {
    return false
  }
  return Object.entries(value).some(
    ([key, child]) =>
      /password|token|secret|authorization|cookie|credential|api[_-]?key/i.test(key) ||
      hasSensitiveKey(child),
  )
}

/**
 * 同步写入独立调用审计。单条插入/更新即为原子操作，不尝试和任意业务事务绑定。
 * 开始写入失败禁止执行；结束写入失败由上层携带实际业务状态报告。
 */
export class AdminAudit {
  constructor(
    private readonly source: () => RelationalAdapter,
    private readonly now: () => string,
  ) {}

  /** 只检查宿主 adapter 的逻辑声明；不建连接、不创建/迁移物理表。 */
  initialize(adapter: RelationalAdapter): void {
    const expected = adminRelationalSchema.tables[ADMIN_OPERATIONS_TABLE]
    const actual = adapter.schema.tables[ADMIN_OPERATIONS_TABLE]
    if (actual?.primaryKey !== expected.primaryKey) {
      throw new AdminError("schema-mismatch", "管理员审计表或主键声明缺失")
    }
    for (const [name, column] of Object.entries(expected.columns)) {
      const found = actual.columns[name]
      if (
        found?.type !== column.type ||
        (found.nullable === true) !== ("nullable" in column && column.nullable === true)
      ) {
        throw new AdminError("schema-mismatch", "管理员审计字段声明与定义不一致")
      }
    }
  }

  safeSummary(value: unknown, maxBytes: number): JsonValue {
    const summary = jsonSnapshot(value, maxBytes, "audit-unavailable")
    if (hasSensitiveKey(summary)) {
      throw new AdminError("audit-unavailable", "审计摘要包含禁止记录的敏感键")
    }
    return summary
  }

  /** 记录准备执行的调用。只有成功确认插入，业务 execute 才能开始。 */
  async start(call: AuditCall): Promise<void> {
    await this.source().execute({
      type: "insert",
      table: ADMIN_OPERATIONS_TABLE,
      value: this.row(call, {
        status: "running",
        execution_state: "not-started",
        wait_status: "waiting",
        error_code: null,
        finished_at: null,
        duration_ms: null,
      }),
    })
  }

  /** 前置拒绝也记录安全元数据；摘要默认为 null，原始异常不写库。 */
  async reject(call: AuditCall, errorCode: string, wait: AdminWaitStatus): Promise<void> {
    await this.source().execute({
      type: "insert",
      table: ADMIN_OPERATIONS_TABLE,
      value: this.row(call, {
        status: "rejected",
        execution_state: "not-started",
        wait_status: wait,
        error_code: errorCode,
        finished_at: this.now(),
        duration_ms: this.duration(call),
      }),
    })
  }

  /** 业务状态与等待状态分别记录，例如 succeeded + timeout。 */
  async finish(
    call: AuditCall,
    state: AdminExecutionState,
    wait: AdminWaitStatus,
    errorCode: string | null,
  ): Promise<void> {
    const result = await this.source().execute({
      type: "update",
      table: ADMIN_OPERATIONS_TABLE,
      where: { type: "eq", field: "execution_id", value: call.executionId },
      patch: {
        status: errorCode === null ? "succeeded" : state === "not-started" ? "rejected" : "failed",
        execution_state: state,
        wait_status: wait,
        error_code: errorCode,
        finished_at: this.now(),
        duration_ms: this.duration(call),
      },
    })
    if (result.affectedRows !== 1) {
      throw new AdminError("audit-incomplete", "调用审计开始记录缺失")
    }
  }

  private duration(call: AuditCall): number {
    return Math.max(0, Math.round(performance.now() - call.startedClock))
  }

  private row(call: AuditCall, result: RelationalRecord): RelationalRecord {
    return {
      execution_id: call.executionId,
      request_id: call.requestId,
      operation_name: call.operationName,
      registration_id: call.description?.registrationId ?? null,
      admin_id: call.identity?.admin.adminId ?? null,
      admin_role: call.identity?.admin.role ?? null,
      operation_kind: call.description?.kind ?? null,
      started_at: call.startedAt,
      summary: call.summary,
      ...result,
    }
  }
}
