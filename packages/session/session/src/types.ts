import type { LifecycleNodeContext, LifecycleProcessor } from "toy-lifecycle"
import type { AppendEventInput, SessionHistory } from "toy-session-data"
import type { EventRecord, SessionRecord, TurnHistory, TurnRecord } from "toy-session-storage"

/** 创建 Session 所需的身份和可选业务数据。 */
export interface CreateSessionInput {
  readonly userId: string
  readonly deviceId: string
  /** 传给预处理器，并保存在最终 Session 的 `payload.initial` 中。 */
  readonly payload?: SessionRecord["payload"]
}

/** Session 当前支持的文本用户消息。 */
export interface UserMessage {
  readonly text: string
}

/** 单轮的执行配置，字段含义由执行器定义。值需要支持结构化克隆。 */
export type TurnConfig = Readonly<Record<string, unknown>>

/** 发起一次 Turn 所需的输入。 */
export interface RunTurnInput {
  readonly message: UserMessage
  /** 入队时取快照，开始执行时交给本轮执行器。 */
  readonly config?: TurnConfig
  /** 调用方控制的取消信号，只作用于本轮 Turn。 */
  readonly signal?: AbortSignal
  /** 本轮执行期事件观察器；执行器每产出一个事件就调用一次（流式传输用）。 */
  readonly onEvent?: (event: unknown) => void
}

/** 可作为 Chat 模型输入的历史消息，由已有的文本对话 Event 投影而来。 */
export interface ModelHistoryMessage {
  readonly role: "user" | "assistant"
  readonly content: string
}

/** Agent 接手一轮已创建并写入用户消息的 Turn 时收到的数据和操作。 */
export interface TurnExecutionContext {
  /** 当前 Session 快照，包含身份和创建阶段保存的数据。 */
  readonly session: SessionRecord
  /** 本轮已创建的 Turn 快照，可从中读取 ID 和轮次号。 */
  readonly turn: TurnRecord
  /** 已经写入本轮 `user_message` 的用户消息。 */
  readonly message: UserMessage
  /** 本轮的配置快照，由执行器解析各字段。 */
  readonly config?: TurnConfig
  /** 与 `runTurn` 收到的信号相同。可传给模型请求、工具和子工作流。 */
  readonly signal: AbortSignal | undefined
  /** 本轮执行期事件观察器，由 `runTurn` 的 `onEvent` 传入。 */
  readonly onEvent?: (event: unknown) => void
  /** 截至当前轮已创建的 Turn 总数，包含当前轮。 */
  readonly turnCount: number
  /** 当前轮之前的全部文本对话，按轮次顺序排列。当前用户消息在 `message` 中。 */
  readonly history: readonly ModelHistoryMessage[]

  /**
   * 获取当前轮之前最近几轮的原始 Event。适用于需要工具结果等完整数据的执行器。
   *
   * @param count 要读取的轮数，必须是正整数。
   * @returns 按轮次顺序排列的历史快照。
   */
  getPreviousTurns(count: number): readonly TurnHistory[]

  /**
   * 向当前轮追加助手回复或其他业务事件。在执行器返回前等待这些操作完成。
   *
   * @param events 待追加事件。文本助手回复使用 `assistant_message` 和 `payload: { text }`。
   * @returns 已接收的完整 Event 记录。数据库模式下此时 Event 已入队。
   */
  appendEvents(events: readonly AppendEventInput[]): Promise<readonly EventRecord[]>
}

/** Agent 插件注册的执行函数。返回值原样交还给 `runTurn` 的调用方。 */
export type TurnExecutor = (context: TurnExecutionContext) => unknown | Promise<unknown>

/** 一次成功 Turn 的 ID 和执行器返回值。 */
export interface RunTurnResult {
  readonly turnId: string
  readonly result: unknown
}

/** Session 预处理器收到的创建输入。 */
export interface SessionPreprocessingContext extends CreateSessionInput {
  readonly payload: SessionRecord["payload"]
}

/** Session 后处理器收到的 closing Session 及其全部 Turn/Event 快照。 */
export type SessionPostprocessingContext = SessionHistory

/** Session 工作流可写入 payload 的处理器输出。 */
export type SessionJson = SessionRecord["payload"] | null

/** 以处理器名称索引的前处理或后处理结果。 */
export type SessionWorkflowOutput = Readonly<Record<string, SessionJson>>

/** 生命周期服务写入 Session 记录的 payload，当前格式版本为 1。 */
export interface SessionPayload extends Readonly<Record<string, SessionJson>> {
  /** 用于识别本服务创建的 payload 格式。 */
  readonly kind: "toy-session"
  /** 调用方提供的初始业务数据。 */
  readonly initial: SessionRecord["payload"]
  /** 初始数据来自已有的底层 Session 时，保留其 payload 格式版本。 */
  readonly initialVersion?: number
  /** 创建前各个处理器的结果。 */
  readonly preprocessing: SessionWorkflowOutput
  /** 成功关闭时保存的后处理结果。 */
  readonly postprocessing?: SessionWorkflowOutput
}

/** Session 阶段的处理器，返回值会保存在 Session payload 中。 */
export type SessionProcessor<TContext extends object> = Omit<
  LifecycleProcessor<TContext>,
  "process"
> & {
  /**
   * 执行本阶段的一个节点。
   *
   * @param context 阶段输入和该节点声明的直接依赖结果。
   * @returns JSON 输出。省略返回值时，Session payload 中该节点的结果为 null。
   */
  process(context: LifecycleNodeContext<TContext>): SessionJson | void | Promise<SessionJson | void>
}

/** Session 对业务插件暴露的阶段注册入口。 */
export interface SessionPhase<TContext extends object> {
  /**
   * 向当前阶段注册处理器。
   *
   * @param processor 节点名称、执行函数和可选的阶段内依赖。
   * @returns 注销函数。插件卸载时调用，影响之后发起的运行。
   */
  register(processor: SessionProcessor<TContext>): () => void
}
