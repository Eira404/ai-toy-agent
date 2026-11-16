/** Session 存储对外稳定暴露的错误类别。 */
export type SessionStorageErrorCode =
  | "invalid-input"
  | "session-not-found"
  | "turn-not-found"
  | "active-session-exists"
  | "invalid-state"
  | "source-not-ready"
  | "schema-mismatch"

/** 业务层可根据 code 区分输入、状态和持久化错误。 */
export class SessionStorageError extends Error {
  constructor(
    readonly code: SessionStorageErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = "SessionStorageError"
  }
}
