import type { LlmProviderCapabilities, LlmToolSchema, ToolCallBlock, ToolSchema } from "toy-llm"

/** 本次工具调用所属的用户、玩偶和对话轮次。 */
export interface ToolScope {
  readonly userId: string
  readonly deviceId: string
  readonly sessionId: string
  readonly turnId: string
}

/** Handler 执行上下文。取消信号应继续传给下游操作。 */
export interface ToolExecutionContext extends ToolScope {
  readonly toolCallId: string
  readonly signal?: AbortSignal
  /**
   * 记录需要持久化但不暴露给模型的额外结构化数据（例如检索到的记忆 id）。
   * 该数据会随工具结果写入 Session 事件，但不会进入发给模型的工具结果文本。
   */
  record(data: ToolJsonValue): void
}

/** 可序列化并交回模型的工具输出。 */
export type ToolJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly ToolJsonValue[]
  | { readonly [key: string]: ToolJsonValue }

/** 本地工具声明。parameters 是根类型为 object 的 JSON Schema。 */
export interface ToolDefinition extends ToolSchema {
  /**
   * 按本次请求的身份和 Turn 数据决定工具是否可用。省略时默认可用。
   *
   * @param scope 当前用户、玩偶和对话轮次。
   * @param payload 当前 Turn 的业务数据，由工具自行解析。调用方省略时收到空对象。
   * @returns 当前模型请求是否可以使用此工具。
   */
  isAvailable?(scope: ToolScope, payload: Readonly<Record<string, unknown>>): boolean

  /**
   * 执行工具。
   *
   * @param argumentsValue 已通过 JSON Schema 校验的模型参数。
   * @param context 当前 Turn 的身份、工具调用 ID 和可选取消信号。
   * @returns JSON 结果。省略返回值时按 null 处理。
   */
  execute(
    argumentsValue: unknown,
    context: ToolExecutionContext,
  ): ToolJsonValue | void | Promise<ToolJsonValue | void>
}

/**
 * 由模型供应商执行的内置工具声明。没有本地 `execute` 函数，仅当 Provider 声明支持时才注入。
 * 注册时无需写 `kind`，`resolve` 会补上 `kind: "builtin"`。
 */
export interface BuiltinToolDeclaration {
  readonly name: string
  readonly description: string
  readonly options?: Readonly<Record<string, unknown>>
  /**
   * 按本次请求的身份和 Turn 数据决定是否注入。省略时默认注入。
   * 返回 false 时该内置工具不会发给模型。
   */
  isAvailable?(scope: ToolScope, payload: Readonly<Record<string, unknown>>): boolean
}

/** 本次模型请求选择工具所需的范围、Turn 数据与 Provider 能力。 */
export interface ToolResolutionContext {
  readonly scope: ToolScope
  /** 当前 Turn 的业务数据，原样传给各工具的 `isAvailable`。 */
  readonly payload?: Readonly<Record<string, unknown>>
  readonly providerCapabilities: Pick<LlmProviderCapabilities, "functionTools" | "builtinTools">
}

/** 工具调用失败的位置。普通错误可作为模型工具结果返回。 */
export type ToolErrorPhase = "resolution" | "parse" | "validation" | "execution"

/** 可以转成 LLM 工具结果消息的调用结果。 */
export interface ToolExecutionResult {
  readonly toolCallId: string
  /** 发送给模型的文本内容。 */
  readonly content: string
  readonly isError: boolean
  /** 工具通过 `context.record` 记录、需要持久化但不暴露给模型的额外数据。 */
  readonly data?: ToolJsonValue
  readonly error?: {
    readonly phase: ToolErrorPhase
    readonly message: string
  }
}

/** 发给模型的工具描述与之对应的本地执行快照。 */
export interface ResolvedToolSet {
  /** 本次请求注入的工具联合：本地 function 工具 + 供应商 builtin 工具。 */
  readonly schemas: readonly LlmToolSchema[]

  /**
   * 执行模型从此快照请求的本地工具。取消时以信号原因拒绝。
   *
   * @param call 模型返回的调用 ID、名称和原始参数。
   * @param options 可选的本轮取消信号。
   * @returns 可用于构造模型工具结果消息的文本和状态。
   */
  execute(
    call: ToolCallBlock,
    options?: { readonly signal?: AbortSignal },
  ): Promise<ToolExecutionResult>
}
