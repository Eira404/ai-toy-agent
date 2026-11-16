/** `toy-memory-read` 的错误码。 */
export type ReadMemoryErrorCode =
  /** 调用方输入非法（空 ID、非法模式等）。 */
  | "invalid-input"

/** Read 包统一抛出的业务错误，携带稳定错误码供上层区分处理。 */
export class ReadMemoryError extends Error {
  readonly code: ReadMemoryErrorCode

  constructor(code: ReadMemoryErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = "ReadMemoryError"
    this.code = code
  }
}
