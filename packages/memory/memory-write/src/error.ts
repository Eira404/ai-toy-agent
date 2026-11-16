/** `toy-memory-write` 的错误码。 */
export type FastWriteErrorCode =
  /** 调用方输入非法（空字段、空草稿等）。 */
  | "invalid-input"

/** Write 包统一抛出的业务错误。 */
export class FastWriteError extends Error {
  readonly code: FastWriteErrorCode

  constructor(code: FastWriteErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = "FastWriteError"
    this.code = code
  }
}
