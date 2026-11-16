import type { ContentBlock, TokenUsage } from "toy-llm"
import type { LifecycleNodeContext, LifecycleProcessor } from "toy-lifecycle"
import type { ModelHistoryMessage, TurnConfig } from "toy-session"
import type { AppendEventInput } from "toy-session-data"
import type { EventRecord, SessionRecord, TurnHistory, TurnRecord } from "toy-session-storage"

/** 向当前 Turn 追加事件的写入句柄；只在执行器返回前有效。 */
export type TurnEventWriter = (
  events: readonly AppendEventInput[],
) => Promise<readonly EventRecord[]>

/** 模型调用前的阻塞预处理上下文；`signal` 与 `upstream` 由生命周期执行器注入。 */
export interface TurnPreprocessingContext {
  readonly session: SessionRecord
  readonly turn: TurnRecord
  readonly message: string
  readonly config: TurnConfig
  readonly turnCount: number
  /** 当前轮之前的文本对话。 */
  readonly history: readonly ModelHistoryMessage[]
  /** 当前轮之前的完整 Turn/Event 快照，可用于读取工具事件等完整数据。 */
  readonly previousTurns: readonly TurnHistory[]
}

/** 模型回答后、返回前的阻塞后处理上下文；可写 Session 事件，结果对下一轮可见。 */
export interface TurnBlockingPostContext {
  readonly session: SessionRecord
  readonly turn: TurnRecord
  readonly message: string
  /** 最终回答的完整内容块。 */
  readonly answer: readonly ContentBlock[]
  /** 最终回答的可见文本。 */
  readonly text: string
  readonly preprocessing: Readonly<Record<string, unknown>>
  readonly usage: TokenUsage | undefined
  readonly appendEvents: TurnEventWriter
}

/** 回答后异步执行的非阻塞后处理上下文；冻结快照，不能写 Session 事件。 */
export interface TurnNonBlockingPostContext {
  readonly session: SessionRecord
  readonly turn: TurnRecord
  readonly message: string
  readonly answer: readonly ContentBlock[]
  readonly text: string
  readonly preprocessing: Readonly<Record<string, unknown>>
  readonly blockingPost: Readonly<Record<string, unknown>>
  readonly usage: TokenUsage | undefined
  readonly capturedAt: number
}

/** 生命周期阶段对业务插件暴露的注册入口。 */
export interface TurnPhase<TContext extends object> {
  /**
   * 向当前阶段注册处理器。
   *
   * @param processor 节点名称、依赖和执行函数。
   * @returns 注销函数。插件卸载时调用，影响之后发起的运行。
   */
  register(processor: LifecycleProcessor<TContext>): () => void
}

/** 预处理节点收到的完整上下文：阶段输入 + 生命周期注入的 upstream/state/signal。 */
export type TurnPreprocessingNodeContext = LifecycleNodeContext<TurnPreprocessingContext>
/** 阻塞后处理节点收到的完整上下文。 */
export type TurnBlockingPostNodeContext = LifecycleNodeContext<TurnBlockingPostContext>
/** 非阻塞后处理节点收到的完整上下文。 */
export type TurnNonBlockingPostNodeContext = LifecycleNodeContext<TurnNonBlockingPostContext>
