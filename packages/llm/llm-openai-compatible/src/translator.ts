import {
  LlmError,
  type ContentBlock,
  type FinishReason,
  type StreamChunk,
  type TokenUsage,
} from "toy-llm"

interface OpenBlock {
  readonly index: number
  readonly type: ContentBlock["type"]
  text: string
  id: string
  name: string
  arguments: string
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new LlmError(`${label} 不是对象`, "MALFORMED_RESPONSE")
  }
  return value as Record<string, unknown>
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0
}

/** 将 OpenAI-compatible usage 映射到统一统计。 */
function parseUsage(raw: unknown): TokenUsage | undefined {
  if (raw === undefined || raw === null) {
    return undefined
  }
  const usage = object(raw, "usage")
  const promptDetails =
    usage.prompt_tokens_details === undefined || usage.prompt_tokens_details === null
      ? undefined
      : object(usage.prompt_tokens_details, "prompt_tokens_details")
  const completionDetails =
    usage.completion_tokens_details === undefined || usage.completion_tokens_details === null
      ? undefined
      : object(usage.completion_tokens_details, "completion_tokens_details")
  const total = usage.total_tokens
  const cached = promptDetails?.cached_tokens
  const reasoning = completionDetails?.reasoning_tokens
  return {
    inputTokens: numberOrZero(usage.prompt_tokens),
    outputTokens: numberOrZero(usage.completion_tokens),
    ...(typeof total === "number" ? { totalTokens: total } : {}),
    ...(typeof cached === "number" ? { cachedInputTokens: cached } : {}),
    ...(typeof reasoning === "number" ? { reasoningTokens: reasoning } : {}),
  }
}

function mapFinishReason(raw: unknown): FinishReason | undefined {
  switch (raw) {
    case undefined:
    case null:
      return undefined
    case "stop":
      return { kind: "stop" }
    case "tool_calls":
    case "function_call":
      return { kind: "tool-calls" }
    case "length":
      return { kind: "max-tokens" }
    case "content_filter":
      return {
        kind: "error",
        failure: { message: "Provider 内容过滤器终止了输出", code: "CONTENT_FILTER" },
      }
    default:
      return {
        kind: "error",
        failure: { message: `未知 finish_reason：${String(raw)}`, code: "UNKNOWN_FINISH_REASON" },
      }
  }
}

/**
 * 把 OpenAI Chat Completions 增量响应翻译成统一 StreamChunk。
 * 一个实例只处理一次请求；每个 SSE JSON 调用 `push()`，流末尾调用 `finish()`。
 */
export class OpenAIStreamTranslator {
  private readonly blocks = new Map<number, OpenBlock>()
  private readonly order: number[] = []
  private usage: TokenUsage | undefined
  private terminal: FinishReason | undefined

  /** 翻译一个 SSE JSON 对象，可能产生多个统一片段。 */
  push(raw: unknown): StreamChunk[] {
    const event = object(raw, "SSE 事件")
    if (event.error !== undefined) {
      const providerError = object(event.error, "Provider error")
      throw new LlmError(
        typeof providerError.message === "string" ? providerError.message : "Provider 返回错误",
        typeof providerError.code === "string" ? providerError.code : "PROVIDER_ERROR",
      )
    }

    this.usage = parseUsage(event.usage) ?? this.usage
    const choices = event.choices
    if (choices === undefined) {
      return []
    }
    if (!Array.isArray(choices)) {
      throw new LlmError("Provider choices 不是数组", "MALFORMED_RESPONSE")
    }

    const chunks: StreamChunk[] = []
    for (const rawChoice of choices) {
      const choice = object(rawChoice, "choice")
      if (choice.index !== undefined && choice.index !== 0) {
        throw new LlmError("当前 Adapter 只支持 n=1", "UNSUPPORTED_RESPONSE")
      }
      const mappedFinish = mapFinishReason(choice.finish_reason)
      if (mappedFinish !== undefined) {
        this.terminal = mappedFinish
      }
      if (choice.delta === undefined) {
        continue
      }

      const delta = object(choice.delta, "choice.delta")
      if (typeof delta.reasoning_content === "string" && delta.reasoning_content.length > 0) {
        const block = this.ensureBlock(0, "reasoning", chunks)
        block.text += delta.reasoning_content
        chunks.push({ type: "reasoning-delta", index: block.index, text: delta.reasoning_content })
      }
      if (typeof delta.content === "string" && delta.content.length > 0) {
        const block = this.ensureBlock(1, "text", chunks)
        block.text += delta.content
        chunks.push({ type: "text-delta", index: block.index, text: delta.content })
      }
      if (delta.tool_calls !== undefined) {
        if (!Array.isArray(delta.tool_calls)) {
          throw new LlmError("delta.tool_calls 不是数组", "MALFORMED_RESPONSE")
        }
        for (const rawCall of delta.tool_calls) {
          const call = object(rawCall, "tool_call")
          if (!Number.isInteger(call.index) || (call.index as number) < 0) {
            throw new LlmError("tool_call.index 无效", "MALFORMED_RESPONSE")
          }
          const block = this.ensureBlock(2 + (call.index as number), "tool-call", chunks)
          if (typeof call.id === "string") {
            block.id ||= call.id
          }
          const fn = call.function === undefined ? {} : object(call.function, "tool_call.function")
          if (typeof fn.name === "string") {
            block.name ||= fn.name
          }
          const argumentsDelta = typeof fn.arguments === "string" ? fn.arguments : ""
          block.arguments += argumentsDelta
          chunks.push({
            type: "tool-call-delta",
            index: block.index,
            id: block.id,
            ...(block.name.length === 0 ? {} : { name: block.name }),
            argumentsDelta,
          })
        }
      }
    }
    return chunks
  }

  /** 关闭所有内容块，并按 `usage → finish` 的协议顺序生成终止片段。 */
  finish(): StreamChunk[] {
    if (this.terminal === undefined) {
      throw new LlmError("Provider 流缺少 finish_reason", "STREAM_CLOSED")
    }
    if (this.blocks.size === 0 && this.terminal.kind === "stop") {
      throw new LlmError("Provider 正常结束但没有返回内容", "EMPTY_RESPONSE")
    }
    if (
      this.terminal.kind === "tool-calls" &&
      ![...this.blocks.values()].some(({ type }) => type === "tool-call")
    ) {
      throw new LlmError("Provider 声明工具调用但没有返回调用内容", "MALFORMED_RESPONSE")
    }

    const chunks: StreamChunk[] = []
    for (const index of this.order) {
      const block = this.blocks.get(index)
      if (block === undefined) {
        continue
      }
      chunks.push({ type: "block-end", index, block: this.completeBlock(block) })
    }
    if (this.usage !== undefined) {
      chunks.push({ type: "usage", usage: this.usage })
    }
    chunks.push({ type: "finish", reason: this.terminal })
    return chunks
  }

  private ensureBlock(index: number, type: ContentBlock["type"], chunks: StreamChunk[]): OpenBlock {
    const existing = this.blocks.get(index)
    if (existing !== undefined) {
      return existing
    }
    const block: OpenBlock = { index, type, text: "", id: "", name: "", arguments: "" }
    this.blocks.set(index, block)
    this.order.push(index)
    chunks.push({ type: "block-start", index, blockType: type })
    return block
  }

  private completeBlock(block: OpenBlock): ContentBlock {
    if (block.type === "text") {
      return { type: "text", text: block.text }
    }
    if (block.type === "reasoning") {
      return { type: "reasoning", text: block.text }
    }
    if (block.id.length === 0 || block.name.length === 0) {
      throw new LlmError("工具调用缺少 id 或 name", "MALFORMED_RESPONSE")
    }
    // 保留模型输出的参数文本，由工具执行边界解析并反馈可修正的错误。
    return {
      type: "tool-call",
      id: block.id,
      name: block.name,
      arguments: block.arguments,
    }
  }
}
