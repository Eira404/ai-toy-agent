import { JevApiError, type JevErrorCode } from "toy-jev"

/** 将 HTTP 状态和响应头转换成供调用方诊断和重试判断的错误。 */
export async function responseError(response: Response): Promise<JevApiError> {
  const body = (await response.text()).slice(0, 500)
  const requestId = response.headers.get("x-request-id") ?? response.headers.get("request-id")
  const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"))
  const { status } = response
  return new JevApiError(status, body, statusCode(status), {
    retryable: status === 408 || status === 429 || status >= 500,
    ...(requestId === null ? {} : { requestId }),
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  })
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

function statusCode(status: number): JevErrorCode {
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
