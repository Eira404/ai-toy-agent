/** Debug 用户存储对外稳定暴露的错误类别。 */
export type DebugUserErrorCode =
  | "invalid-input"
  | "user-exists"
  | "user-not-found"
  | "source-not-ready"
  | "schema-mismatch"

/** 业务层可根据 code 区分输入、状态和持久化错误。 */
export class DebugUserError extends Error {
  constructor(
    readonly code: DebugUserErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = "DebugUserError"
  }
}
