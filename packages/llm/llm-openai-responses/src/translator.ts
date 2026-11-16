import { LlmError, type FinishReason, type StreamChunk } from "toy-llm"
import { ResponseBlocks } from "./blocks.js"
import type { WireItem } from "./continuation.js"
import { failureOf, finishReason, object, usageOf } from "./response.js"

/** 流结束时供适配器生成 finish 和可选续调句柄。 */
export interface TerminalResponse {
  readonly reason: FinishReason
  readonly id: string | undefined
  readonly output: readonly WireItem[]
  readonly callIds: readonly string[]
}

/** 翻译一次 Responses SSE。服务端内置工具只保留在可能用于续调的原始 Item 中。 */
export class OpenAIResponsesStreamTranslator {
  private readonly blocks = new ResponseBlocks()
  private readonly items = new Map<number, WireItem>()
  private responseId: string | undefined
  terminal: TerminalResponse | undefined

  /**
   * 接收一条 typed SSE 事件。
   *
   * @param raw 解码后的 SSE JSON。
   * @returns 本条事件产生的增量、完整块或用量。终止原因通过 terminal 读取。
   */
  push(raw: unknown): StreamChunk[] {
    const event = object(raw, "Responses SSE 事件")
    const type = event.type
    switch (type) {
      case "response.created": {
        const { id } = object(event.response, "response.created.response")
        if (typeof id === "string") {
          this.responseId = id
        }
        return []
      }
      case "response.output_text.delta":
      case "response.output_text.done":
        return this.textEvent(event, "text", type.endsWith(".done"))
      case "response.refusal.delta":
      case "response.refusal.done":
        return this.textEvent(event, "refusal", type.endsWith(".done"))
      case "response.reasoning_text.delta":
      case "response.reasoning_text.done":
        return this.textEvent(event, "reasoning", type.endsWith(".done"))
      case "response.reasoning_summary_text.delta":
      case "response.reasoning_summary_text.done":
        return this.textEvent(event, "summary", type.endsWith(".done"))
      case "response.function_call_arguments.delta":
      case "response.function_call_arguments.done": {
        const done = type.endsWith(".done")
        const value = done ? event.arguments : event.delta
        return typeof value === "string"
          ? this.blocks.toolArguments(itemKey(event.item_id, event.output_index), value, done)
          : []
      }
      case "response.output_item.added": {
        const item = object(event.item, "response.output_item.added.item")
        return item.type === "function_call"
          ? this.blocks.toolItem(itemKey(item.id, event.output_index), item, false)
          : []
      }
      case "response.output_item.done":
        return this.outputItem(
          object(event.item, "response.output_item.done.item"),
          indexOf(event.output_index, this.items.size),
        )
      case "response.completed":
      case "response.incomplete":
      case "response.failed":
        return this.complete(type, object(event.response, "终止事件的 response"))
      case "error": {
        const failure = failureOf(
          event.error === undefined ? event : object(event.error, "SSE error"),
          "Responses 流返回错误",
        )
        throw new LlmError(failure.message, failure.code)
      }
      default:
        if (typeof type !== "string") {
          throw new LlmError("Responses SSE 事件缺少 type", "MALFORMED_RESPONSE")
        }
        return []
    }
  }

  private textEvent(
    event: WireItem,
    kind: Parameters<ResponseBlocks["text"]>[0],
    done: boolean,
  ): StreamChunk[] {
    const value = done ? (kind === "refusal" ? event.refusal : event.text) : event.delta
    const part = indexOf(kind === "summary" ? event.summary_index : event.content_index, 0)
    return typeof value === "string"
      ? this.blocks.text(kind, itemKey(event.item_id, event.output_index), part, value, done)
      : []
  }

  private outputItem(item: WireItem, index: number): StreamChunk[] {
    this.items.set(index, item)
    const key = itemKey(item.id, index)
    if (item.type === "function_call") {
      return this.blocks.toolItem(key, item, true)
    }
    if (item.type === "reasoning") {
      return [
        ...this.textParts(item.summary, key, "summary_text", "summary"),
        ...this.textParts(item.content, key, "reasoning_text", "reasoning"),
      ]
    }
    return item.type === "message" ? this.textParts(item.content, key, "output_text", "text") : []
  }

  private textParts(
    raw: unknown,
    key: string,
    type: string,
    kind: Parameters<ResponseBlocks["text"]>[0],
  ): StreamChunk[] {
    if (!Array.isArray(raw)) {
      return []
    }
    return raw.flatMap((value: unknown, index: number) => {
      const part = object(value, "output item 文本")
      if (part.type === type && typeof part.text === "string") {
        return this.blocks.text(kind, key, index, part.text, true)
      }
      if (kind === "text" && part.type === "refusal" && typeof part.refusal === "string") {
        return this.blocks.text("refusal", key, index, part.refusal, true)
      }
      return []
    })
  }

  private complete(type: string, response: WireItem): StreamChunk[] {
    const chunks: StreamChunk[] = []
    if (Array.isArray(response.output)) {
      for (const [index, item] of response.output.entries()) {
        chunks.push(...this.outputItem(object(item, "response.output item"), index))
      }
    }
    const finished = this.blocks.finish(type === "response.completed")
    chunks.push(...finished.chunks)
    const usage = usageOf(response.usage)
    if (usage !== undefined) {
      chunks.push({ type: "usage", usage })
    }
    this.terminal = {
      id: typeof response.id === "string" ? response.id : this.responseId,
      reason: finishReason(type, response, finished.callIds),
      output: [...this.items].sort(([left], [right]) => left - right).map(([, item]) => item),
      callIds: finished.callIds,
    }
    return chunks
  }
}

function indexOf(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : fallback
}

function itemKey(id: unknown, index: unknown): string {
  if (typeof id === "string" && id.length > 0) {
    return `item:${id}`
  }
  const position = indexOf(index, -1)
  if (position < 0) {
    throw new LlmError("Responses 事件缺少 Item 标识", "MALFORMED_RESPONSE")
  }
  return `index:${position}`
}
