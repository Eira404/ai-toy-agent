import {
  LlmError,
  type GenerateOptions,
  type LlmContinuation,
  type ToolResultMessage,
} from "toy-llm"

/** Responses 请求或响应中的协议 Item。 */
export type WireItem = Readonly<Record<string, unknown>>

/**
 * 验证并构造本轮工具结果回传。工具结果须位于消息尾部，每个请求的调用 ID 恰好对应一次结果。
 *
 * @param options 新请求，包含上次返回的续调句柄。
 * @param store 当前路由是否使用服务端保存。
 * @returns 本次发送的 Item，以及服务端续调需要的响应 ID。
 */
export function prepareContinuation(
  options: GenerateOptions,
  store: boolean,
):
  | {
      readonly input: readonly WireItem[]
      readonly responseId?: string
    }
  | undefined {
  const continuation = options.continuation
  if (continuation === undefined) {
    return undefined
  }
  if (
    continuation.provider !== options.provider ||
    continuation.model !== options.model ||
    continuation.kind !== (store ? "responses-stored" : "responses-stateless")
  ) {
    throw new LlmError("续调句柄与当前路由、模型或保存方式不一致", "INVALID_CONTINUATION")
  }
  const expected = new Set(continuation.callIds)
  const outputs = new Map<string, WireItem>()
  for (let index = options.messages.length - 1; index >= 0; index -= 1) {
    const message = options.messages[index]
    if (message?.role !== "tool") {
      break
    }
    if (!expected.has(message.toolCallId) || outputs.has(message.toolCallId)) {
      throw new LlmError("续调包含未知或重复的工具结果", "INVALID_CONTINUATION")
    }
    outputs.set(message.toolCallId, toolOutput(message))
  }
  if (
    expected.size === 0 ||
    outputs.size !== expected.size ||
    expected.size !== continuation.callIds.length
  ) {
    throw new LlmError("续调需要上一响应的全部工具结果", "INVALID_CONTINUATION")
  }
  const ordered = [...expected].map((id) => outputs.get(id)!)
  return continuation.kind === "responses-stored"
    ? { input: ordered, responseId: continuation.responseId }
    : { input: [...continuation.items, ...ordered] }
}

/** 将本地工具输出关联到模型返回的 call_id。 */
export function toolOutput(message: ToolResultMessage): WireItem {
  return {
    type: "function_call_output",
    call_id: message.toolCallId,
    output: message.content.map(({ text }) => text).join(""),
  }
}

/** 为下一次工具续调生成显式句柄，状态由调用方持有。 */
export function makeContinuation(
  options: GenerateOptions,
  store: boolean,
  input: readonly WireItem[],
  responseId: string | undefined,
  output: readonly WireItem[],
  callIds: readonly string[],
): LlmContinuation {
  const scope = { provider: options.provider, model: options.model, callIds }
  if (store) {
    if (!responseId) {
      throw new LlmError("工具续调需要 Responses 响应 ID", "MALFORMED_RESPONSE")
    }
    return { ...scope, kind: "responses-stored", responseId }
  }
  const replayedCalls = new Set(
    output.filter(({ type }) => type === "function_call").map(({ call_id }) => call_id),
  )
  if (!callIds.every((id) => replayedCalls.has(id))) {
    throw new LlmError("响应缺少无状态工具续调所需的 Item", "MALFORMED_RESPONSE")
  }
  return { ...scope, kind: "responses-stateless", items: [...input, ...output] }
}
