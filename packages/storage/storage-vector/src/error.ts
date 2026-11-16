/** 业务和写入队列可跨向量 adapter 判断的稳定错误码。 */
export type VectorErrorCode =
  | "invalid-schema"
  | "collection-not-found"
  | "invalid-field"
  | "invalid-value"
  | "invalid-operation"
  | "timeout"
  | "cancelled"
  | "connection-failed"
  | "unknown-commit-state"
  | "closed"

/** 统一承载协议校验错误与 adapter 执行错误。 */
export class VectorError extends Error {
  /**
   * @param code 调用方和调度器用于判断处理方式的稳定错误码。
   * @param message 包含集合、字段或操作等上下文的诊断信息。
   * @param options 可通过 cause 保留原始错误。
   */
  constructor(
    readonly code: VectorErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = "VectorError"
  }

  /** adapter 仅在确认写入未提交时使用 timeout 或 connection-failed，允许自动重试。 */
  get retryable(): boolean {
    return this.code === "timeout" || this.code === "connection-failed"
  }

  /** 写入结果无法确认时，队列应保留任务并等待核对。 */
  get unknownState(): boolean {
    return this.code === "unknown-commit-state"
  }
}
