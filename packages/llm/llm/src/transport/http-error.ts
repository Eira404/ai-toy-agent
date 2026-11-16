import { LlmError } from "../error.js"

/** 保留状态码、请求 ID 和重试提示，供调用方判断是否重试。 */
export async function responseError(response: Response): Promise<LlmError> {
  const text = await response.text()
  const detail = responseMessage(text).slice(0, 500)
  const requestId =
    response.headers.get("x-request-id") ??
    response.headers.get("x-dashscope-request-id") ??
    response.headers.get("request-id")
  const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"))
  return new LlmError(detail, statusCode(response.status, detail), {
    status: response.status,
    ...(requestId === null ? {} : { requestId }),
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  })
}

function responseMessage(text: string): string {
  try {
    const raw = JSON.parse(text) as { error?: { message?: unknown }; message?: unknown } | null
    const message = raw?.error?.message ?? raw?.message
    if (typeof message === "string" && message.trim().length > 0) {
      return message.trim()
    }
  } catch {
    // 网关可能返回普通文本，此时使用下方的正文摘要。
  }
  return text.trim() || "Provider 请求失败"
}

function parseRetryAfter(value: string | null): number | undefined {
  if (value === null || value.trim() === "") {
    return undefined
  }
  const seconds = Number(value)
  if (Number.isFinite(seconds)) {
    return seconds >= 0 ? seconds * 1000 : undefined
  }
  const date = Date.parse(value)
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined
}

function statusCode(status: number, detail: string): string {
  if (status === 401 || status === 403) {
    return "AUTH"
  }
  if (status === 429) {
    return "RATE_LIMIT"
  }
  if (status === 413 || status === 400) {
    return /context.{0,30}(?:length|window).{0,30}(?:exceed|overflow|limit)/i.test(detail)
      ? "CONTEXT_WINDOW_EXCEEDED"
      : "INVALID_REQUEST"
  }
  return status >= 500 ? "SERVER" : "HTTP_ERROR"
}
