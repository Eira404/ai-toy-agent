import type { JevFailure } from "./types.js"

/** JEV 调用对上层暴露的稳定错误码。 */
export type JevErrorCode =
  | "INVALID_REQUEST"
  | "NO_ADAPTER"
  | "DUPLICATE_ADAPTER"
  | "AUTH"
  | "RATE_LIMIT"
  | "TIMEOUT"
  | "ABORTED"
  | "INVALID_RESPONSE"
  | "SERVER"
  | "HTTP_ERROR"
  | "TRANSPORT"
  | "FALLBACK_EXHAUSTED"

export interface JevErrorOptions extends ErrorOptions {
  readonly retryable?: boolean
  readonly status?: number
  readonly responseBody?: string
  readonly retryAfterMs?: number
  readonly requestId?: string
  readonly attempts?: readonly JevFailure[]
}

/** JEV 核心与 Adapter 共用的稳定异常。 */
export class JevError extends Error {
  override readonly name: string = "JevError"
  readonly retryable: boolean
  readonly status: number | undefined
  readonly responseBody: string | undefined
  readonly retryAfterMs: number | undefined
  readonly requestId: string | undefined
  readonly attempts: readonly JevFailure[] | undefined

  constructor(
    message: string,
    readonly code: JevErrorCode,
    options: JevErrorOptions = {},
  ) {
    super(message, options)
    this.retryable = options.retryable ?? false
    this.status = options.status
    this.responseBody = options.responseBody
    this.retryAfterMs = options.retryAfterMs
    this.requestId = options.requestId
    this.attempts = options.attempts
  }
}

/** 带 HTTP 状态和原始响应摘要的 JEV API 错误。 */
export class JevApiError extends JevError {
  override readonly name = "JevApiError"

  constructor(
    status: number,
    responseBody: string,
    code: JevErrorCode,
    options: Omit<JevErrorOptions, "status" | "responseBody"> = {},
  ) {
    const detail = responseBody.trim() || "响应体为空"
    super(`JEV TypeSafe 接口返回 HTTP ${status}：${detail}`, code, {
      ...options,
      status,
      responseBody,
    })
  }
}
