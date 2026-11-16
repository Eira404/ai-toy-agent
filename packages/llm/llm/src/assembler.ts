import { LlmError } from "./error.js"
import type {
  ContentBlock,
  FinishReason,
  GenerateResult,
  LlmContinuation,
  StreamChunk,
  TokenUsage,
} from "./types.js"

interface PartialBlock {
  readonly type: ContentBlock["type"]
  text: string
  id: string
  name: string
  arguments: string
  block?: ContentBlock
}

/**
 * 把 token 级 StreamChunk 拼装成完整内容块。
 *
 * 调用方式：流循环中执行 `assembler.push(chunk)`，流结束后读取 `result()`。
 */
export class BlockAssembler {
  private readonly partials = new Map<number, PartialBlock>()
  private readonly order: number[] = []
  private usageValue: TokenUsage | undefined
  private finishValue: FinishReason | undefined
  private continuation: LlmContinuation | undefined

  /** 接收一个流片段并更新组装状态。 */
  push(chunk: StreamChunk): void {
    switch (chunk.type) {
      case "block-start":
        this.ensure(chunk.index, chunk.blockType)
        return
      case "text-delta":
        this.ensure(chunk.index, "text").text += chunk.text
        return
      case "reasoning-delta":
        this.ensure(chunk.index, "reasoning").text += chunk.text
        return
      case "tool-call-delta": {
        const partial = this.ensure(chunk.index, "tool-call")
        partial.id ||= chunk.id
        partial.name ||= chunk.name ?? ""
        partial.arguments += chunk.argumentsDelta
        return
      }
      case "block-end":
        this.ensure(chunk.index, chunk.block.type).block = chunk.block
        return
      case "usage":
        this.usageValue = chunk.usage
        return
      case "continuation":
        this.continuation = chunk.continuation
        return
      case "finish":
        this.finishValue = chunk.reason
    }
  }

  /** 返回当前已见内容块；未显式结束的块会使用累积增量组装。 */
  blocks(): ContentBlock[] {
    return this.order.map((index) => {
      const partial = this.partials.get(index)
      if (partial === undefined) {
        throw new LlmError(`缺少流内容块 ${index}`, "MALFORMED_STREAM")
      }
      if (partial.block !== undefined) {
        return partial.block
      }
      if (partial.type === "text") {
        return { type: "text", text: partial.text }
      }
      if (partial.type === "reasoning") {
        return { type: "reasoning", text: partial.text }
      }
      return {
        type: "tool-call",
        id: partial.id,
        name: partial.name,
        arguments: partial.arguments,
      }
    })
  }

  /** 流结束后返回完整结果；缺少 finish 表示 Adapter 违反协议。 */
  result(): GenerateResult {
    if (this.finishValue === undefined) {
      throw new LlmError("LLM 流缺少终止片段", "MALFORMED_STREAM")
    }
    return {
      content: this.blocks(),
      ...(this.usageValue === undefined ? {} : { usage: this.usageValue }),
      ...(this.finishValue.kind === "tool-calls" && this.continuation !== undefined
        ? { continuation: this.continuation }
        : {}),
      finish: this.finishValue,
    }
  }

  private ensure(index: number, type: ContentBlock["type"]): PartialBlock {
    const existing = this.partials.get(index)
    if (existing !== undefined) {
      if (existing.type !== type) {
        throw new LlmError(`流内容块 ${index} 的类型发生变化`, "MALFORMED_STREAM")
      }
      return existing
    }

    const partial: PartialBlock = {
      type,
      text: "",
      id: "",
      name: "",
      arguments: "",
    }
    this.partials.set(index, partial)
    this.order.push(index)
    return partial
  }
}
