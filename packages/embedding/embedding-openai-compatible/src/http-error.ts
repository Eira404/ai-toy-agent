import { EmbeddingError } from "toy-embedding"

/** 将 HTTP 状态和响应头转换成供调用方诊断和重试判断的错误。 */
export async function responseError(response: Response): Promise<EmbeddingError> {
  const text = await response.text()
  const detail = responseMessage(text).slice(0, 500)
  const requestId = response.headers.get("x-request-id") ?? response.headers.get("request-id")
  const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"))
  return new EmbeddingError(detail, statusCode(response.status), {
    status: response.status,
    retryable: response.status === 408 || response.status === 429 || response.status >= 500,
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

function statusCode(status: number): string {
  if (status === 401 || status === 403) {
    return "AUTH"
  }
  if (status === 429) {
    return "RATE_LIMIT"
  }
  if (status >= 500) {
    return "SERVER"
  }
  return [400, 404, 413].includes(status) ? "INVALID_REQUEST" : "HTTP_ERROR"
}
