import type { EmbeddingFailure } from "./types.js"

/** 构造 EmbeddingError 时允许携带的 Provider 诊断信息。 */
export interface EmbeddingErrorOptions extends ErrorOptions {
  /** 该失败是否适合安全重试，默认为 false。 */
  readonly retryable?: boolean
  /** Provider 返回的 HTTP 状态码。 */
  readonly status?: number
  /** 服务端建议的重试等待毫秒数。 */
  readonly retryAfterMs?: number
  /** 服务端用于定位单次请求的 ID。 */
  readonly requestId?: string
  /** 降级链全部失败时，各候选按尝试顺序记录的失败摘要。 */
  readonly attempts?: readonly EmbeddingFailure[]
}

/**
 * 嵌入调用统一异常。
 *
 * 调用方应判断 `code` 或 `retryable`，不要解析人类可读的 message。
 */
export class EmbeddingError extends Error {
  override readonly name: string = "EmbeddingError"
  readonly retryable: boolean
  readonly status: number | undefined
  readonly retryAfterMs: number | undefined
  readonly requestId: string | undefined
  readonly attempts: readonly EmbeddingFailure[] | undefined

  constructor(
    message: string,
    readonly code: string,
    options: EmbeddingErrorOptions = {},
  ) {
    super(message, options)
    this.retryable = options.retryable ?? false
    this.status = options.status
    this.retryAfterMs = options.retryAfterMs
    this.requestId = options.requestId
    this.attempts = options.attempts
  }
}

/** 将任意 Adapter 抛出值转换为稳定的 EmbeddingError，供上层统一处理。 */
export function normalizeEmbeddingFailure(error: unknown): EmbeddingError {
  if (error instanceof EmbeddingError) {
    return error
  }
  if (error instanceof Error) {
    return new EmbeddingError(error.message || "嵌入调用失败", "UNKNOWN", {
      retryable: true,
      cause: error,
    })
  }
  return new EmbeddingError(String(error), "UNKNOWN", { retryable: true })
}
