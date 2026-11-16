import type { LlmFailure } from "./types.js"

/** 构造 LlmError 时允许携带的 Provider 诊断信息。 */
export interface LlmErrorOptions extends ErrorOptions {
  readonly status?: number
  readonly retryAfterMs?: number
  readonly requestId?: string
  readonly attempts?: readonly LlmFailure[]
}

/**
 * LLM 调用统一异常。
 *
 * 调用方应判断 `code` 或 `failure.code`，不要解析人类可读的 message。
 */
export class LlmError extends Error {
  override readonly name = "LlmError"
  readonly failure: LlmFailure

  constructor(
    message: string,
    readonly code: string,
    options?: LlmErrorOptions,
  ) {
    super(message, options)
    this.failure = Object.freeze({
      message,
      code,
      ...(options?.status === undefined ? {} : { status: options.status }),
      ...(options?.retryAfterMs === undefined ? {} : { retryAfterMs: options.retryAfterMs }),
      ...(options?.requestId === undefined ? {} : { requestId: options.requestId }),
      ...(options?.attempts === undefined ? {} : { attempts: options.attempts }),
    })
  }
}

/** 将任意 Adapter 抛出值转换为稳定、可序列化的失败信息。 */
export function normalizeLlmFailure(error: unknown): LlmFailure {
  if (error instanceof LlmError) {
    return error.failure
  }
  if (error instanceof Error) {
    return Object.freeze({ message: error.message || "LLM 调用失败", code: "UNKNOWN" })
  }
  return Object.freeze({ message: String(error), code: "UNKNOWN" })
}
