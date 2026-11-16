import { LlmError, type GenerateOptions, type LlmMessage, type LlmToolSchema } from "toy-llm"
import type { ResolvedConfig } from "./config.js"
import { prepareContinuation, toolOutput, type WireItem } from "./continuation.js"

/** 已组装的请求体。input 会用于构造无状态续调句柄。 */
export interface ResponsesRequest extends Readonly<Record<string, unknown>> {
  readonly input: readonly WireItem[]
}

/** 把通用聊天历史转为 Responses Item。系统消息单独放在 instructions。 */
export function serializeMessages(messages: readonly LlmMessage[]): {
  readonly instructions?: string
  readonly input: readonly WireItem[]
} {
  const instructions: string[] = []
  const input: WireItem[] = []
  for (const message of messages) {
    if (message.role === "tool") {
      input.push(toolOutput(message))
      continue
    }
    const text = message.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("")
    if (message.role === "system") {
      if (text.length > 0) {
        instructions.push(text)
      }
    } else if (text.length > 0) {
      input.push({ role: message.role, content: text })
    }
    if (message.role === "assistant") {
      for (const block of message.content) {
        if (block.type === "tool-call") {
          input.push({
            type: "function_call",
            call_id: block.id,
            name: block.name,
            arguments: block.arguments,
          })
        }
      }
    }
  }
  return {
    ...(instructions.length === 0 ? {} : { instructions: instructions.join("\n\n") }),
    input,
  }
}

/**
 * 构造一次 Responses 请求，将工具、结构化输出和思考配置转换成供应商字段。
 *
 * @param options 通用模型输入和可选续调句柄。
 * @param config 当前路由的保存方式和能力。
 * @returns 可直接序列化为请求 JSON 的数据。
 */
export function serializeRequest(
  options: GenerateOptions,
  config: ResolvedConfig,
): ResponsesRequest {
  if (options.stop?.length) {
    throw new LlmError("Responses 不支持 stop 选项", "UNSUPPORTED_OPTION")
  }
  if (options.responseFormat !== undefined && !config.capabilities.jsonSchema) {
    throw new LlmError("当前 Responses 路由不支持结构化输出", "UNSUPPORTED_OPTION")
  }
  const messages = serializeMessages(options.messages)
  const continuation = prepareContinuation(options, config.store)
  const reasoning = serializeReasoning(options, config)
  return {
    model: options.model,
    stream: true,
    store: config.store,
    input: continuation?.input ?? messages.input,
    ...(messages.instructions === undefined ? {} : { instructions: messages.instructions }),
    ...(continuation?.responseId === undefined
      ? {}
      : { previous_response_id: continuation.responseId }),
    ...(!config.store && config.capabilities.reasoning && reasoning?.effort !== "none"
      ? { include: ["reasoning.encrypted_content"] }
      : {}),
    ...(options.tools === undefined
      ? {}
      : { tools: options.tools.map((tool) => serializeTool(tool, config)) }),
    ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
    ...(options.maxTokens === undefined ? {} : { max_output_tokens: options.maxTokens }),
    ...(options.responseFormat === undefined ? {} : { text: { format: options.responseFormat } }),
    ...(reasoning === undefined ? {} : { reasoning }),
  }
}

function serializeTool(tool: LlmToolSchema, config: ResolvedConfig): WireItem {
  if (tool.kind === "function" && config.capabilities.functionTools) {
    return {
      type: "function",
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      strict: false,
    }
  }
  if (tool.kind === "builtin" && config.capabilities.builtinTools.includes(tool.name)) {
    return { ...tool.options, type: tool.name }
  }
  throw new LlmError(`当前 Responses 路由不支持工具 '${tool.name}'`, "UNSUPPORTED_TOOL")
}

function serializeReasoning(
  options: GenerateOptions,
  config: ResolvedConfig,
): WireItem | undefined {
  const { reasoning } = options
  if (reasoning?.enabled !== false && reasoning?.budgetTokens !== undefined) {
    throw new LlmError("Responses 使用 reasoning.effort 控制思考强度", "UNSUPPORTED_OPTION")
  }
  const effort =
    reasoning?.enabled === false
      ? "none"
      : (reasoning?.effort ?? (reasoning?.enabled ? "medium" : undefined))
  const summary = effort === "none" ? undefined : config.reasoningSummary
  if (effort === undefined && summary === undefined) {
    return undefined
  }
  if (!config.capabilities.reasoning) {
    throw new LlmError("当前 Responses 路由不支持思考配置", "UNSUPPORTED_OPTION")
  }
  return {
    ...(effort === undefined ? {} : { effort }),
    ...(summary === undefined ? {} : { summary }),
  }
}
