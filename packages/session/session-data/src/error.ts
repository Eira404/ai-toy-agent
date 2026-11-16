/** 上层可区分输入错误、缺失数据和运行状态错误。 */
export type SessionDataErrorCode =
  | "invalid-input"
  | "session-not-found"
  | "turn-not-found"
  | "not-resident"
  | "active-session-exists"
  | "invalid-state"
  | "storage-unavailable"

/** Session 数据服务的稳定错误类型。 */
export class SessionDataError extends Error {
  constructor(
    readonly code: SessionDataErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = "SessionDataError"
  }
}
