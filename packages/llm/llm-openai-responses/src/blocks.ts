import { LlmError, type ContentBlock, type StreamChunk } from "toy-llm"
import type { WireItem } from "./continuation.js"

type TextKind = "text" | "refusal" | "reasoning" | "summary"

interface BlockState {
  readonly index: number
  closed: boolean
}

interface TextState extends BlockState {
  readonly type: "text" | "reasoning"
  text: string
}

interface ToolState extends BlockState {
  readonly type: "tool-call"
  id: string
  name: string
  arguments: string
}

/** 逐个累积 Responses 文本和函数调用，按协议 Item 归并重复的 done 事件。 */
export class ResponseBlocks {
  private readonly texts = new Map<string, TextState>()
  private readonly tools = new Map<string, ToolState>()
  private readonly order: (TextState | ToolState)[] = []

  /** 处理文本或 reasoning 的增量与完整结束文本。 */
  text(kind: TextKind, item: string, part: number, value: string, done: boolean): StreamChunk[] {
    const key = `${kind}:${item}:${part}`
    const chunks: StreamChunk[] = []
    let block = this.texts.get(key)
    if (block === undefined) {
      if (value.length === 0) {
        return chunks
      }
      const type = kind === "text" || kind === "refusal" ? "text" : "reasoning"
      block = { index: this.order.length, type, closed: false, text: "" }
      this.texts.set(key, block)
      this.order.push(block)
      chunks.push({ type: "block-start", index: block.index, blockType: type })
    }
    if (block.closed) {
      return chunks
    }
    const delta = done ? suffix(block.text, value) : value
    block.text = done ? value : block.text + value
    if (delta.length > 0) {
      chunks.push(
        block.type === "text"
          ? { type: "text-delta", index: block.index, text: delta }
          : { type: "reasoning-delta", index: block.index, text: delta },
      )
    }
    if (done) {
      this.close(block, chunks, true)
    }
    return chunks
  }

  /** 绑定函数 Item 的 call_id/name。完整参数保留原始字符串，由 Tools 层解析。 */
  toolItem(key: string, item: WireItem, done: boolean): StreamChunk[] {
    const chunks: StreamChunk[] = []
    const block = this.ensureTool(key, chunks)
    if (block.closed) {
      return chunks
    }
    if (typeof item.call_id === "string") {
      block.id = item.call_id
    }
    if (typeof item.name === "string") {
      block.name = item.name
    }
    if (typeof item.arguments === "string") {
      this.addArguments(block, item.arguments, true, chunks)
    }
    if (done) {
      // 终止响应到达后才验证标识，以允许不完整流返回已接收的片段。
      this.close(block, chunks, false)
    }
    return chunks
  }

  /** 处理参数增量或 arguments.done 的完整参数。 */
  toolArguments(key: string, value: string, done: boolean): StreamChunk[] {
    const chunks: StreamChunk[] = []
    const block = this.ensureTool(key, chunks)
    if (!block.closed) {
      this.addArguments(block, value, done, chunks)
    }
    return chunks
  }

  /** 结束仍开启的块。成功响应必须为每个本地函数提供唯一的 call_id。 */
  finish(success: boolean): { chunks: StreamChunk[]; callIds: string[] } {
    const chunks: StreamChunk[] = []
    for (const block of this.order) {
      this.close(block, chunks, success)
    }
    const callIds = [...this.tools.values()].filter(({ closed }) => closed).map(({ id }) => id)
    if (success && new Set(callIds).size !== callIds.length) {
      throw new LlmError("Responses 返回重复的 call_id", "MALFORMED_RESPONSE")
    }
    return { chunks, callIds }
  }

  private ensureTool(key: string, chunks: StreamChunk[]): ToolState {
    const existing = this.tools.get(key)
    if (existing !== undefined) {
      return existing
    }
    const block: ToolState = {
      index: this.order.length,
      type: "tool-call",
      closed: false,
      id: "",
      name: "",
      arguments: "",
    }
    this.tools.set(key, block)
    this.order.push(block)
    chunks.push({ type: "block-start", index: block.index, blockType: block.type })
    return block
  }

  private addArguments(
    block: ToolState,
    value: string,
    done: boolean,
    chunks: StreamChunk[],
  ): void {
    const delta = done ? suffix(block.arguments, value) : value
    block.arguments = done ? value : block.arguments + value
    if (delta.length > 0) {
      chunks.push({
        type: "tool-call-delta",
        index: block.index,
        id: block.id,
        ...(block.name ? { name: block.name } : {}),
        argumentsDelta: delta,
      })
    }
  }

  private close(
    block: TextState | ToolState,
    chunks: StreamChunk[],
    requireCallIdentity: boolean,
  ): void {
    if (block.closed) {
      return
    }
    let content: ContentBlock
    if (block.type === "tool-call") {
      if (!block.id || !block.name) {
        if (requireCallIdentity) {
          throw new LlmError("Responses 函数调用缺少 call_id 或 name", "MALFORMED_RESPONSE")
        }
        return
      }
      content = { type: block.type, id: block.id, name: block.name, arguments: block.arguments }
    } else {
      content = { type: block.type, text: block.text }
    }
    block.closed = true
    chunks.push({ type: "block-end", index: block.index, block: content })
  }
}

/** 完整值重复携带已发送内容时，只补发还没发出的后缀。 */
function suffix(previous: string, full: string): string {
  return full.startsWith(previous) ? full.slice(previous.length) : ""
}
