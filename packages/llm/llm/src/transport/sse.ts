import { LlmError } from "../error.js"

const DONE = Symbol("SSE_DONE")

/** 从一个 SSE frame 提取并解析所有 data 行。 */
function parseFrame(frame: string): unknown | undefined | typeof DONE {
  const data = frame
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n")
  if (data === "[DONE]") {
    return DONE
  }
  if (data.length === 0) {
    return undefined
  }
  try {
    return JSON.parse(data)
  } catch (error) {
    throw new LlmError("Provider SSE 包含无效 JSON", "MALFORMED_RESPONSE", { cause: error })
  }
}

/**
 * 逐帧解析模型 SSE 响应。
 *
 * 调用方式：把 `fetch()` 返回的 `response.body` 传入并遍历结果；
 * 函数兼容 CRLF、跨网络分片和多行 data。
 */
export async function* parseSse(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): AsyncGenerator<unknown> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  const cancelRead = () => {
    void reader.cancel(signal.reason).catch(() => undefined)
  }
  signal.addEventListener("abort", cancelRead, { once: true })

  try {
    while (true) {
      signal.throwIfAborted()
      const { done, value } = await reader.read()
      signal.throwIfAborted()
      buffer += decoder.decode(value, { stream: !done })

      let separator = /\r?\n\r?\n/.exec(buffer)
      while (separator !== null) {
        const frame = buffer.slice(0, separator.index)
        buffer = buffer.slice(separator.index + separator[0].length)
        const parsed = parseFrame(frame)
        if (parsed === DONE) {
          return
        }
        if (parsed !== undefined) {
          yield parsed
        }
        separator = /\r?\n\r?\n/.exec(buffer)
      }

      if (done) {
        const parsed = parseFrame(buffer)
        if (parsed !== undefined && parsed !== DONE) {
          yield parsed
        }
        return
      }
    }
  } finally {
    signal.removeEventListener("abort", cancelRead)
    // 提前结束消费时也释放网络读取。
    void reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}
