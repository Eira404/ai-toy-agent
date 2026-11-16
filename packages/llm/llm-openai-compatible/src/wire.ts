import { LlmError, type GenerateOptions, type LlmMessage } from "toy-llm"

/** OpenAI Chat Completions 请求体中一条消息的最小结构。 */
export type WireMessage = Record<string, unknown> & { role: string }

/** 把统一消息转换成 OpenAI-compatible Chat Completions 消息。 */
export function serializeMessages(messages: readonly LlmMessage[]): WireMessage[] {
  return messages.map((message) => {
    if (message.role === "tool") {
      return {
        role: "tool",
        tool_call_id: message.toolCallId,
        content: message.content.map((block) => block.text).join(""),
      }
    }

    const text = message.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("")
    if (message.role !== "assistant") {
      const unsupported = message.content.find((block) => block.type !== "text")
      if (unsupported !== undefined) {
        throw new LlmError(
          `${message.role} 消息暂不支持 '${unsupported.type}' 内容`,
          "UNSUPPORTED_CONTENT",
        )
      }
      return { role: message.role, content: text }
    }

    const reasoning = message.content
      .filter((block) => block.type === "reasoning")
      .map((block) => block.text)
      .join("")
    const toolCalls = message.content
      .filter((block) => block.type === "tool-call")
      .map((block) => ({
        id: block.id,
        type: "function",
        function: { name: block.name, arguments: block.arguments },
      }))

    return {
      role: "assistant",
      content: text.length === 0 ? null : text,
      ...(reasoning.length === 0 ? {} : { reasoning_content: reasoning }),
      ...(toolCalls.length === 0 ? {} : { tool_calls: toolCalls }),
    }
  })
}

/** Adapter 配置中会影响请求体的默认项。 */
export interface RequestDefaults {
  readonly enableThinking?: boolean
  readonly thinkingBudget?: number
  readonly toolStream?: boolean
}

/**
 * 构造原生 HTTP 请求体。
 * 百炼的非标准字段必须放在顶层，不能包进 OpenAI SDK 风格的 `extra_body`。
 */
export function serializeRequest(
  options: GenerateOptions,
  defaults: RequestDefaults,
): Record<string, unknown> {
  if (options.continuation !== undefined) {
    throw new LlmError("此 Chat Completions 路由使用完整消息续调", "UNSUPPORTED_OPTION")
  }
  if (options.reasoning?.effort !== undefined) {
    throw new LlmError("此路由使用 thinkingBudget 控制思考预算", "UNSUPPORTED_OPTION")
  }
  const enableThinking = options.reasoning?.enabled ?? defaults.enableThinking
  const thinkingBudget = options.reasoning?.budgetTokens ?? defaults.thinkingBudget
  return {
    model: options.model,
    messages: serializeMessages(options.messages),
    stream: true,
    stream_options: { include_usage: true },
    ...(options.tools === undefined
      ? {}
      : {
          tools: options.tools.map((tool) => {
            // Provider 内置工具不是本地 function，不能伪装成 Chat Completions 函数声明。
            if (tool.kind !== "function") {
              throw new LlmError(
                `Chat Completions 路由不支持内置工具 '${tool.name}'`,
                "UNSUPPORTED_TOOL",
              )
            }
            return {
              type: "function",
              function: {
                name: tool.name,
                description: tool.description,
                parameters: tool.parameters,
              },
            }
          }),
        }),
    ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
    ...(options.maxTokens === undefined ? {} : { max_tokens: options.maxTokens }),
    ...(options.stop === undefined ? {} : { stop: [...options.stop] }),
    ...(options.responseFormat === undefined
      ? {}
      : {
          response_format: {
            type: options.responseFormat.type,
            json_schema: {
              name: options.responseFormat.name,
              schema: options.responseFormat.schema,
              ...(options.responseFormat.description === undefined
                ? {}
                : { description: options.responseFormat.description }),
              ...(options.responseFormat.strict === undefined
                ? {}
                : { strict: options.responseFormat.strict }),
            },
          },
        }),
    ...(enableThinking === undefined ? {} : { enable_thinking: enableThinking }),
    ...(enableThinking === false || thinkingBudget === undefined
      ? {}
      : { thinking_budget: thinkingBudget }),
    ...(defaults.toolStream === undefined ? {} : { tool_stream: defaults.toolStream }),
  }
}
