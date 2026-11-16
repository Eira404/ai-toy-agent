import { Service, type Context } from "cordis"
import type { ContentBlock, LlmMessage, LlmToolSchema, TokenUsage } from "toy-llm"
import type { LifecycleResult } from "toy-lifecycle"
import type { TurnExecutionContext } from "toy-session"

/** Agent 执行器从 Session 收到的一轮输入，由 `TurnExecutionContext` 归一化而来。 */
export type AgentTurnInput = TurnExecutionContext

/** 一次模型调用产生的可观察步骤。 */
export interface AgentStep {
  readonly index: number
  readonly content: readonly ContentBlock[]
  readonly usage?: TokenUsage
}

/** 一轮 Agent Loop 的最终结果，作为 `runTurn` 的 `result` 交还给调用方。 */
export interface AgentResult {
  readonly turnId: string
  readonly text: string
  readonly content: readonly ContentBlock[]
  readonly preprocessing: LifecycleResult
  readonly blockingPost: LifecycleResult
  readonly steps: readonly AgentStep[]
  readonly usage?: TokenUsage
}

/**
 * Agent 执行过程输出给事件接收器（当前为内存收集器，未来为 gRPC server-stream）的统一事件。
 *
 * `step` 字段表示当前 Turn 内的模型调用序号；`assistant-delta` 的 `channel` 区分可见文本与思考过程。
 */
export type AgentEvent =
  | { readonly type: "run-start"; readonly sessionId: string; readonly turnId: string }
  | {
      readonly type: "preprocessing-complete"
      readonly result: LifecycleResult
      readonly durationMs: number
    }
  | {
      readonly type: "model-request"
      readonly step: number
      readonly messages: readonly LlmMessage[]
      readonly tools: readonly LlmToolSchema[]
    }
  | { readonly type: "model-ttft"; readonly step: number; readonly durationMs: number }
  | { readonly type: "agent-ttft"; readonly step: number; readonly durationMs: number }
  | {
      readonly type: "assistant-delta"
      readonly step: number
      readonly channel: "text" | "reasoning"
      readonly delta: string
    }
  | {
      readonly type: "assistant-complete"
      readonly step: number
      readonly content: readonly ContentBlock[]
      readonly durationMs: number
      readonly usage?: TokenUsage
    }
  | {
      readonly type: "tool-start"
      readonly step: number
      readonly toolCallId: string
      readonly name: string
      readonly arguments: string
    }
  | {
      readonly type: "tool-complete"
      readonly step: number
      readonly toolCallId: string
      readonly name: string
      readonly output: string
      readonly isError: boolean
      readonly durationMs: number
    }
  | {
      readonly type: "blocking-post-complete"
      readonly result: LifecycleResult
      readonly durationMs: number
    }
  | { readonly type: "nonblocking-post-dispatched"; readonly jobId: string }
  | { readonly type: "complete"; readonly result: AgentResult; readonly durationMs: number }

/** Agent Loop 实现需要满足的最小接口。 */
export interface AgentRunner {
  stream(input: AgentTurnInput): AsyncIterable<AgentEvent>
}

declare module "cordis" {
  interface Context {
    agent: AgentService
  }
}

export type AgentErrorCode = "NO_RUNNER" | "INVALID_REQUEST" | "LLM_ERROR" | "ABORTED" | "MAX_STEPS"

/** Agent 对外稳定错误。 */
export class AgentError extends Error {
  override readonly name = "AgentError"

  constructor(
    message: string,
    readonly code: AgentErrorCode,
    options?: ErrorOptions,
  ) {
    super(message, options)
  }
}

/**
 * Agent 对外入口：持有公共契约，并把 Session 的 Turn 执行器转发给唯一注册的 Agent Loop。
 *
 * 加载 `toy-agent-loop` 后，循环会通过 `registerRunner()` 注册自身；本服务在挂载时就把
 * `ctx.session.registerTurnExecutor` 接好，运行期再从 runner 拉取事件流。
 */
export class AgentService extends Service {
  static inject = ["session"]

  private runner: AgentRunner | undefined

  constructor(ctx: Context) {
    super(ctx, "agent")
    ctx.effect(
      () => ctx.session.registerTurnExecutor((input) => this.run(input)),
      "agent.registerTurnExecutor",
    )
  }

  /** 注册唯一的 Agent Loop 实现，并返回释放函数。 */
  registerRunner(runner: AgentRunner): () => void {
    if (this.runner !== undefined) {
      throw new AgentError("Agent Runner 已注册", "INVALID_REQUEST")
    }
    this.runner = runner
    let released = false
    return () => {
      if (!released && this.runner === runner) {
        released = true
        this.runner = undefined
      }
    }
  }

  /** 流式执行一轮 Agent 请求，事件接收器（当前为收集器，未来为 gRPC）逐个消费。 */
  stream(input: AgentTurnInput): AsyncIterable<AgentEvent> {
    if (this.runner === undefined) {
      throw new AgentError("没有注册 Agent Loop", "NO_RUNNER")
    }
    return this.runner.stream(input)
  }

  /** 执行一轮请求并等待最终结果；普通业务不需要处理流事件时使用。 */
  async run(input: AgentTurnInput): Promise<AgentResult> {
    let result: AgentResult | undefined
    for await (const event of this.stream(input)) {
      input.onEvent?.(event)
      if (event.type === "complete") {
        result = event.result
      }
    }
    if (result === undefined) {
      throw new AgentError("Agent 事件流在 complete 事件之前结束", "LLM_ERROR")
    }
    return result
  }
}

export default AgentService
