/** 上层可以跨内存、MySQL、PostgreSQL adapter 稳定判断的错误码。 */
export type RelationalErrorCode =
  | "invalid-schema"
  | "table-not-found"
  | "invalid-field"
  | "invalid-value"
  | "invalid-operation"
  | "duplicate-key"
  | "constraint-violation"
  | "transaction-conflict"
  | "timeout"
  | "cancelled"
  | "connection-failed"
  | "unknown-commit-state"
  | "closed"

/** 跨 adapter 保持稳定的关系型存储错误。 */
export class RelationalError extends Error {
  /**
   * 创建一个带稳定错误码和可选底层原因的协议错误。
   *
   * @param code 上层流程判断使用的稳定错误码。
   * @param message 面向开发者的诊断信息。
   * @param options 可选 cause，保留数据库驱动的原始异常。
   */
  constructor(
    readonly code: RelationalErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = "RelationalError"
  }

  /** 只有明确没有进入未知提交状态的临时错误才允许自动重试。 */
  get retryable(): boolean {
    return this.code === "connection-failed" || this.code === "timeout"
  }

  /** 是否无法确认数据库 COMMIT 最终成功或失败。 */
  get unknownState(): boolean {
    return this.code === "unknown-commit-state"
  }
}
