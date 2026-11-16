/** 记忆反馈对外稳定暴露的错误类别。 */
export type MemoryFeedbackErrorCode =
  | "invalid-input"
  | "source-not-ready"
  | "schema-mismatch"
  | "engine-not-registered"
  | "engine-already-registered"
  | "invalid-state"

/** 业务层可根据 code 区分输入、状态和持久化错误。 */
export class MemoryFeedbackError extends Error {
  constructor(
    readonly code: MemoryFeedbackErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = "MemoryFeedbackError"
  }
}
