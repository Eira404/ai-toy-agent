/** 写入队列对调用方公开的稳定错误类别。 */
export type WriteQueueErrorCode =
  | "invalid-job"
  | "duplicate-job"
  | "target-unavailable"
  | "job-blocked"
  | "wait-timeout"
  | "wait-cancelled"
  | "queue-closed"
  | "invalid-receipt"

/** 队列的入队、等待和目标调度错误。 */
export class WriteQueueError extends Error {
  /**
   * @param code 上层可稳定判断的错误类别。
   * @param message 错误说明。
   * @param options 可选底层原因。
   */
  constructor(
    readonly code: WriteQueueErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = "WriteQueueError"
  }
}
