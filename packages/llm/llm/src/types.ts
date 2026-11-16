/** 用户或模型可见的普通文本。 */
export interface TextBlock {
  readonly type: "text"
  readonly text: string
}

/** 模型的思考过程，与最终可见文本分开保存。 */
export interface ReasoningBlock {
  readonly type: "reasoning"
  readonly text: string
}

/** 模型请求执行一个工具；arguments 保留模型返回的原始 JSON 字符串。 */
export interface ToolCallBlock {
  readonly type: "tool-call"
  readonly id: string
  readonly name: string
  readonly arguments: string
}

/** 第一阶段支持的内容块。 */
export type ContentBlock = TextBlock | ReasoningBlock | ToolCallBlock

/** System、User 和 Assistant 共用的消息形态。 */
export interface ContentMessage {
  readonly role: "system" | "user" | "assistant"
  readonly content: readonly ContentBlock[]
}

/** 与某次工具调用对应的工具结果消息。 */
export interface ToolResultMessage {
  readonly role: "tool"
  readonly toolCallId: string
  readonly content: readonly TextBlock[]
  readonly isError?: boolean
}

/** Provider 无关的完整消息联合。 */
export type LlmMessage = ContentMessage | ToolResultMessage

/** 发送给模型的函数工具定义。 */
export interface ToolSchema {
  readonly name: string
  readonly description: string
  readonly parameters: Readonly<Record<string, unknown>>
}

/** 模型侧函数工具；kind 只用于统一工具联合，不改变业务插件的 ToolDefinition 写法。 */
export interface FunctionToolSchema extends ToolSchema {
  readonly kind: "function"
}

/** 由模型供应商执行的内置工具，不存在本地 execute 函数。 */
export interface BuiltinToolSchema {
  readonly kind: "builtin"
  readonly name: string
  readonly description: string
  readonly options?: Readonly<Record<string, unknown>>
}

/** 单次模型请求实际注入的工具联合。 */
export type LlmToolSchema = FunctionToolSchema | BuiltinToolSchema

/** Provider 无关的思考控制；具体 Adapter 负责映射到线上协议。 */
export interface ReasoningOptions {
  readonly enabled?: boolean
  readonly budgetTokens?: number
  /** 对支持等级控制的模型指定思考强度。 */
  readonly effort?: ReasoningEffort
}

/** 模型思考强度，具体可用值取决于所选模型。 */
export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"

/** 工具结果回传所需的协议状态。调用方应将它限制在本轮模型循环内。 */
export type LlmContinuation = {
  readonly provider: string
  readonly model: string
  readonly callIds: readonly string[]
} & (
  | { readonly kind: "responses-stored"; readonly responseId: string }
  | {
      readonly kind: "responses-stateless"
      readonly items: readonly Readonly<Record<string, unknown>>[]
    }
)

/** 要求 Provider 按指定 JSON Schema 生成结构化内容。 */
export interface JsonSchemaResponseFormat {
  readonly type: "json_schema"
  readonly name: string
  readonly description?: string
  readonly schema: Readonly<Record<string, unknown>>
  readonly strict?: boolean
}

/** Provider 无关的响应格式约束。 */
export type ResponseFormat = JsonSchemaResponseFormat

/** 单次模型请求。 */
export interface GenerateOptions {
  readonly provider: string
  readonly model: string
  readonly messages: readonly LlmMessage[]
  readonly tools?: readonly LlmToolSchema[]
  readonly temperature?: number
  readonly maxTokens?: number
  readonly stop?: readonly string[]
  readonly reasoning?: ReasoningOptions
  readonly responseFormat?: ResponseFormat
  /** 从上一次工具调用结果取得的续调句柄。 */
  readonly continuation?: LlmContinuation
  readonly signal?: AbortSignal
}

/** Provider 无关、可安全记录的失败信息。 */
export interface LlmFailure {
  readonly message: string
  readonly code: string
  readonly status?: number
  readonly retryAfterMs?: number
  readonly requestId?: string
  /** 降级链全部失败时，各候选按尝试顺序记录的失败信息。 */
  readonly attempts?: readonly LlmFailure[]
}

/** 模型正常或异常结束的原因。 */
export type FinishReason =
  | { readonly kind: "stop" }
  | { readonly kind: "tool-calls" }
  | { readonly kind: "max-tokens" }
  | { readonly kind: "aborted"; readonly failure: LlmFailure }
  | { readonly kind: "error"; readonly failure: LlmFailure }

/** 单次调用的 Token 统计；inputTokens 表示 Provider 报告的总输入 Token。 */
export interface TokenUsage {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly totalTokens?: number
  readonly cachedInputTokens?: number
  readonly reasoningTokens?: number
}

/** Adapter 向调用方输出的统一流式协议。 */
export type StreamChunk =
  | {
      readonly type: "block-start"
      readonly index: number
      readonly blockType: ContentBlock["type"]
    }
  | { readonly type: "text-delta"; readonly index: number; readonly text: string }
  | { readonly type: "reasoning-delta"; readonly index: number; readonly text: string }
  | {
      readonly type: "tool-call-delta"
      readonly index: number
      readonly id: string
      readonly name?: string
      readonly argumentsDelta: string
    }
  | { readonly type: "block-end"; readonly index: number; readonly block: ContentBlock }
  | { readonly type: "usage"; readonly usage: TokenUsage }
  | { readonly type: "continuation"; readonly continuation: LlmContinuation }
  | { readonly type: "finish"; readonly reason: FinishReason }

/** `generate()` 返回的一次完整组装结果。 */
export interface GenerateResult {
  readonly content: readonly ContentBlock[]
  readonly usage?: TokenUsage
  /** 支持续调的路由在需要回传本地工具结果时返回。 */
  readonly continuation?: LlmContinuation
  readonly finish: FinishReason
}

/** Adapter 注册后对外展示的 Provider 信息。 */
export interface LlmProviderInfo {
  readonly id: string
  readonly name: string
  readonly protocol: "chat-completions" | "responses" | "custom"
  readonly capabilities: LlmProviderCapabilities
}

/** Adapter 路由对外声明的协议能力，供调用前的工具解析策略使用。 */
export interface LlmProviderCapabilities {
  readonly functionTools: boolean
  readonly builtinTools: readonly string[]
  readonly jsonSchema: boolean
  readonly reasoning: boolean
}

/** 降级链中的一个候选路由条目。 */
export interface LlmRouteEntry {
  /** 已注册的 adapter 路由名。 */
  readonly provider: string
  /** 该候选实际使用的模型名。 */
  readonly model: string
}

/** 判定某次失败是否应继续降级到下一个候选；返回 true 表示继续尝试。 */
export type LlmFallbackPredicate = (failure: LlmFailure) => boolean

/** 降级链的可选行为配置。 */
export interface LlmChainOptions {
  /** 覆盖默认的「可降级失败」判定。默认对传输/超时/流异常、408、429 与 5xx 降级。 */
  readonly retryable?: LlmFallbackPredicate
  /**
   * 每次切换候选时回调，用于观测与告警。
   * `attempt` 为失败候选的 0-based 索引，`entry` 为该候选，`failure` 为其失败信息。
   */
  readonly onFallback?: (attempt: number, entry: LlmRouteEntry, failure: LlmFailure) => void
}
