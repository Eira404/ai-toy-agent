import { Service, type Context } from "cordis"
import {
  AgentError,
  type AgentEvent,
  type AgentResult,
  type AgentRunner,
  type AgentStep,
  type AgentTurnInput,
} from "toy-agent"
import {
  BlockAssembler,
  type ContentBlock,
  type ContentMessage,
  type GenerateResult,
  type LlmMessage,
  type ReasoningOptions,
  type TokenUsage,
  type ToolCallBlock,
} from "toy-llm"
import { LifecycleGraph } from "toy-lifecycle"
import type { TurnConfig } from "toy-session"
import type { ToolScope } from "toy-tools"
import { buildSystemPrompt, type PromptAssembler } from "./prompt.js"
import { BackgroundQueue } from "./queue.js"
import type {
  TurnBlockingPostContext,
  TurnNonBlockingPostContext,
  TurnPhase,
  TurnPreprocessingContext,
} from "./types.js"

export interface AgentLoopConfig {
  /** 默认模型路由；可被单轮 `config.provider` 覆盖。 */
  readonly provider?: string
  /** 默认模型名；可被单轮 `config.model` 覆盖。 */
  readonly model?: string
  /** 基础 System Message。 */
  readonly systemPrompt?: string
  /** 单轮内模型 + 工具的最大步数，默认 8。 */
  readonly maxSteps?: number
  /** 预处理可见的最近完整 Turn 数，默认 16。 */
  readonly recentTurns?: number
  /** 默认思考配置；例如 `{ enabled: false }` 关闭模型思考。 */
  readonly reasoning?: ReasoningOptions
}

interface NormalizedConfig {
  readonly provider?: string
  readonly model?: string
  readonly systemPrompt: string
  readonly maxSteps: number
  readonly recentTurns: number
  readonly reasoning?: ReasoningOptions
}

/** Agent Loop 的内置默认组装器：System 用基础指令 + 预处理 + 工具说明，User 返回原文。 */
const builtinPromptAssembler: PromptAssembler = {
  assembleSystemPrompt: (context) => buildSystemPrompt(context, []),
  assembleUserMessage: (context) => context.message,
}

declare module "cordis" {
  interface Context {
    agentLoop: AgentLoop
  }
}

function addUsage(
  total: TokenUsage | undefined,
  current: TokenUsage | undefined,
): TokenUsage | undefined {
  if (current === undefined) {
    return total
  }
  return {
    inputTokens: (total?.inputTokens ?? 0) + current.inputTokens,
    outputTokens: (total?.outputTokens ?? 0) + current.outputTokens,
    ...(total?.totalTokens === undefined && current.totalTokens === undefined
      ? {}
      : { totalTokens: (total?.totalTokens ?? 0) + (current.totalTokens ?? 0) }),
    ...(total?.cachedInputTokens === undefined && current.cachedInputTokens === undefined
      ? {}
      : { cachedInputTokens: (total?.cachedInputTokens ?? 0) + (current.cachedInputTokens ?? 0) }),
    ...(total?.reasoningTokens === undefined && current.reasoningTokens === undefined
      ? {}
      : { reasoningTokens: (total?.reasoningTokens ?? 0) + (current.reasoningTokens ?? 0) }),
  }
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value
  }
  Object.freeze(value)
  for (const child of Object.values(value)) {
    deepFreeze(child)
  }
  return value
}

/**
 * 默认事件日志 Agent Loop：实现 Turn 预处理、模型与工具闭环、阻塞后处理和非阻塞后处理。
 *
 * 会话由 `toy-session` 提前创建并把 Turn 交给本循环；循环通过 `appendEvents` 写入事件日志，
 * 不直接访问 Provider handle 或存储实例。
 */
export class AgentLoop extends Service implements AgentRunner {
  static inject = ["agent", "llm", "tools"]

  private readonly config: NormalizedConfig
  private readonly preGraph = new LifecycleGraph<TurnPreprocessingContext>()
  private readonly blockingGraph = new LifecycleGraph<TurnBlockingPostContext>()
  private readonly nonBlockingGraph = new LifecycleGraph<TurnNonBlockingPostContext>()
  private readonly background = new BackgroundQueue()
  private promptAssembler: PromptAssembler | undefined

  /** 模型调用前运行的阻塞预处理注册入口。 */
  readonly preprocessing: TurnPhase<TurnPreprocessingContext> = {
    register: (processor) => this.preGraph.register(processor),
  }

  /** 回答后、返回前运行的阻塞后处理注册入口；结果对下一轮可见。 */
  readonly blockingPost: TurnPhase<TurnBlockingPostContext> = {
    register: (processor) => this.blockingGraph.register(processor),
  }

  /** 回答后后台运行的非阻塞后处理注册入口；不能写 Session 事件。 */
  readonly nonBlockingPost: TurnPhase<TurnNonBlockingPostContext> = {
    register: (processor) => this.nonBlockingGraph.register(processor),
  }

  constructor(ctx: Context, config: AgentLoopConfig = {}) {
    super(ctx, "agentLoop")
    const maxSteps = config.maxSteps ?? 8
    if (!Number.isSafeInteger(maxSteps) || maxSteps <= 0) {
      throw new TypeError("maxSteps 必须是正整数")
    }
    const recentTurns = config.recentTurns ?? 16
    if (!Number.isSafeInteger(recentTurns) || recentTurns <= 0) {
      throw new TypeError("recentTurns 必须是正整数")
    }
    this.config = {
      ...(config.provider === undefined ? {} : { provider: config.provider }),
      ...(config.model === undefined ? {} : { model: config.model }),
      systemPrompt: config.systemPrompt ?? "你是一个可靠、简洁的 AI 助手。",
      maxSteps,
      recentTurns,
      ...(config.reasoning === undefined ? {} : { reasoning: config.reasoning }),
    }
    ctx.effect(() => ctx.agent.registerRunner(this), "agentLoop.registerRunner")
  }

  /**
   * 注册唯一的消息组装插件，替换内置默认组装器；返回释放函数恢复默认。
   * `SystemPromptAssembler` 在加载时会通过 `ctx.effect` 调用本方法。
   */
  registerPromptAssembler(assembler: PromptAssembler): () => void {
    if (this.promptAssembler !== undefined) {
      throw new AgentError("Prompt Assembler 已注册", "INVALID_REQUEST")
    }
    this.promptAssembler = assembler
    let released = false
    return () => {
      if (!released && this.promptAssembler === assembler) {
        released = true
        this.promptAssembler = undefined
      }
    }
  }

  /** 流式执行一轮 Agent 请求，逐事件输出给接收器（当前为收集器，未来为 gRPC）。 */
  stream(input: AgentTurnInput): AsyncIterable<AgentEvent> {
    return this.execute(input)
  }

  /** 仅用于测试和优雅停机，等待已投递的非阻塞后处理收尾。 */
  waitForIdle(): Promise<void> {
    return this.background.waitForIdle()
  }

  private async *execute(input: AgentTurnInput): AsyncGenerator<AgentEvent, AgentResult> {
    const runStartedAt = performance.now()
    const { session, turn, message, signal } = input
    const query = message.text
    yield { type: "run-start", sessionId: session.sessionId, turnId: turn.turnId }

    // ① 阻塞预处理
    const preprocessingStartedAt = performance.now()
    const preprocessing = await this.preGraph.run(
      {
        session,
        turn,
        message: query,
        config: input.config ?? {},
        turnCount: input.turnCount,
        history: input.history,
        previousTurns: input.getPreviousTurns(this.config.recentTurns),
      },
      signal === undefined ? {} : { signal },
    )
    yield {
      type: "preprocessing-complete",
      result: preprocessing,
      durationMs: performance.now() - preprocessingStartedAt,
    }

    // ② 模型 + 工具循环
    const route = this.resolveRoute(input.config)
    const generation = {
      ...this.resolveGeneration(input.config),
      ...(this.config.reasoning === undefined ? {} : { reasoning: this.config.reasoning }),
    }
    const toolScope: ToolScope = Object.freeze({
      userId: session.userId,
      deviceId: session.deviceId,
      sessionId: session.sessionId,
      turnId: turn.turnId,
    })

    const promptAssembler = this.promptAssembler ?? builtinPromptAssembler
    const userMessage = await promptAssembler.assembleUserMessage({
      session,
      turn,
      message: query,
      basePrompt: this.config.systemPrompt,
      preprocessing,
      tools: [],
    })
    const messages: LlmMessage[] = [
      ...input.history.map((entry): ContentMessage => ({
        role: entry.role,
        content: [{ type: "text", text: entry.content }],
      })),
      { role: "user", content: [{ type: "text", text: userMessage }] },
    ]

    const steps: AgentStep[] = []
    let usage: TokenUsage | undefined
    let agentTtftEmitted = false
    let finalContent: readonly ContentBlock[] = []

    for (let stepIndex = 0; stepIndex < this.config.maxSteps; stepIndex += 1) {
      const providerInfo = this.ctx.llm.providerInfo(route.provider)
      const toolSet = this.ctx.tools.resolve({
        scope: toolScope,
        payload: preprocessing.data,
        providerCapabilities: providerInfo.capabilities,
      })
      const systemText = await promptAssembler.assembleSystemPrompt({
        session,
        turn,
        message: query,
        basePrompt: this.config.systemPrompt,
        preprocessing,
        tools: toolSet.schemas,
      })
      const fullMessages: LlmMessage[] = [
        { role: "system", content: [{ type: "text", text: systemText }] },
        ...messages,
      ]
      yield {
        type: "model-request",
        step: stepIndex,
        messages: fullMessages,
        tools: toolSet.schemas,
      }

      const modelStartedAt = performance.now()
      const assembler = new BlockAssembler()
      let modelTtftEmitted = false
      for await (const chunk of this.ctx.llm.stream({
        provider: route.provider,
        model: route.model,
        messages: fullMessages,
        tools: toolSet.schemas,
        ...generation,
        ...(signal === undefined ? {} : { signal }),
      })) {
        assembler.push(chunk)
        const isContentDelta =
          chunk.type === "text-delta" ||
          chunk.type === "reasoning-delta" ||
          chunk.type === "tool-call-delta"
        if (isContentDelta && !modelTtftEmitted) {
          modelTtftEmitted = true
          yield {
            type: "model-ttft",
            step: stepIndex,
            durationMs: performance.now() - modelStartedAt,
          }
        }
        if (chunk.type === "text-delta") {
          if (!agentTtftEmitted) {
            agentTtftEmitted = true
            yield {
              type: "agent-ttft",
              step: stepIndex,
              durationMs: performance.now() - runStartedAt,
            }
          }
          yield { type: "assistant-delta", step: stepIndex, channel: "text", delta: chunk.text }
        } else if (chunk.type === "reasoning-delta") {
          yield {
            type: "assistant-delta",
            step: stepIndex,
            channel: "reasoning",
            delta: chunk.text,
          }
        }
      }

      const generated = assembler.result()
      this.assertGenerated(generated, signal)
      const assistantText = this.textOf(generated.content)
      // 纯工具调用步骤不产生可见文本，跳过空 assistant_message，避免污染下一轮文本历史。
      if (assistantText.length > 0) {
        await input.appendEvents([
          { eventType: "assistant_message", payload: { text: assistantText } },
        ])
      }
      messages.push({ role: "assistant", content: generated.content })
      steps.push({
        index: stepIndex,
        content: generated.content,
        ...(generated.usage === undefined ? {} : { usage: generated.usage }),
      })
      usage = addUsage(usage, generated.usage)
      yield {
        type: "assistant-complete",
        step: stepIndex,
        content: generated.content,
        durationMs: performance.now() - modelStartedAt,
        ...(generated.usage === undefined ? {} : { usage: generated.usage }),
      }

      const calls = generated.content.filter(
        (block): block is ToolCallBlock => block.type === "tool-call",
      )
      if (calls.length === 0) {
        finalContent = generated.content
        break
      }

      if (stepIndex + 1 >= this.config.maxSteps) {
        for (const call of calls) {
          const output = "已达到 Agent 最大步数，工具未执行。"
          await input.appendEvents([
            {
              eventType: "tool_call",
              payload: { toolCallId: call.id, name: call.name, arguments: call.arguments },
            },
            {
              eventType: "tool_result",
              payload: { toolCallId: call.id, name: call.name, output, isError: true },
            },
          ])
          yield {
            type: "tool-complete",
            step: stepIndex,
            toolCallId: call.id,
            name: call.name,
            output,
            isError: true,
            durationMs: 0,
          }
        }
        throw new AgentError("Agent 达到最大步骤数", "MAX_STEPS")
      }

      for (const call of calls) {
        yield {
          type: "tool-start",
          step: stepIndex,
          toolCallId: call.id,
          name: call.name,
          arguments: call.arguments,
        }
        await input.appendEvents([
          {
            eventType: "tool_call",
            payload: { toolCallId: call.id, name: call.name, arguments: call.arguments },
          },
        ])
        const startedAt = performance.now()
        const result = await toolSet.execute(call, signal === undefined ? undefined : { signal })
        const durationMs = performance.now() - startedAt
        await input.appendEvents([
          {
            eventType: "tool_result",
            payload: {
              toolCallId: call.id,
              name: call.name,
              output: result.content,
              isError: result.isError,
              ...(result.data === undefined ? {} : { data: result.data }),
            },
          },
        ])
        messages.push({
          role: "tool",
          toolCallId: call.id,
          content: [{ type: "text", text: result.content }],
          ...(result.isError ? { isError: true } : {}),
        })
        yield {
          type: "tool-complete",
          step: stepIndex,
          toolCallId: call.id,
          name: call.name,
          output: result.content,
          isError: result.isError,
          durationMs,
        }
      }
    }

    if (finalContent.length === 0) {
      throw new AgentError("Agent 达到最大步骤数", "MAX_STEPS")
    }
    const finalText = this.textOf(finalContent)

    // ③ 阻塞后处理：回答后、返回前，仍占用队列，结果对下一轮可见。
    const blockingStartedAt = performance.now()
    const blockingPost = await this.blockingGraph.run(
      {
        session,
        turn,
        message: query,
        answer: finalContent,
        text: finalText,
        preprocessing: preprocessing.data,
        usage,
        appendEvents: input.appendEvents,
      },
      signal === undefined ? {} : { signal },
    )
    yield {
      type: "blocking-post-complete",
      result: blockingPost,
      durationMs: performance.now() - blockingStartedAt,
    }

    // ④ 非阻塞后处理：返回后后台执行，不占队列；冻结快照，不能写 Session 事件。
    const snapshot = deepFreeze(
      structuredClone({
        session,
        turn,
        message: query,
        answer: finalContent,
        text: finalText,
        preprocessing: preprocessing.data,
        blockingPost: blockingPost.data,
        usage,
        capturedAt: Date.now(),
      }),
    )
    const jobId = `turn-post:${session.sessionId}:${turn.turnId}`
    this.background.dispatch(
      jobId,
      () => this.nonBlockingGraph.run(snapshot),
      (id, error) => {
        this.ctx.logger("agent-loop").warn("Turn 非阻塞后处理 %s 失败：%o", id, error)
      },
    )
    yield { type: "nonblocking-post-dispatched", jobId }

    const result: AgentResult = {
      turnId: turn.turnId,
      text: finalText,
      content: finalContent,
      preprocessing,
      blockingPost,
      steps,
      ...(usage === undefined ? {} : { usage }),
    }
    yield { type: "complete", result, durationMs: performance.now() - runStartedAt }
    return result
  }

  private resolveRoute(config: TurnConfig | undefined): {
    readonly provider: string
    readonly model: string
  } {
    const provider =
      typeof config?.provider === "string" && config.provider.trim().length > 0
        ? config.provider
        : this.config.provider
    const model =
      typeof config?.model === "string" && config.model.trim().length > 0
        ? config.model
        : this.config.model
    if (provider === undefined || model === undefined) {
      throw new AgentError("provider 和 model 不能为空", "INVALID_REQUEST")
    }
    return { provider, model }
  }

  private resolveGeneration(config: TurnConfig | undefined): {
    readonly temperature?: number
    readonly maxTokens?: number
  } {
    const temperature =
      typeof config?.temperature === "number" && Number.isFinite(config.temperature)
        ? config.temperature
        : undefined
    const maxTokens =
      typeof config?.maxTokens === "number" && Number.isSafeInteger(config.maxTokens)
        ? config.maxTokens
        : undefined
    return {
      ...(temperature === undefined ? {} : { temperature }),
      ...(maxTokens === undefined ? {} : { maxTokens }),
    }
  }

  private assertGenerated(result: GenerateResult, signal?: AbortSignal): void {
    if (result.finish.kind === "error") {
      throw new AgentError(result.finish.failure.message, "LLM_ERROR")
    }
    if (result.finish.kind === "aborted") {
      throw new AgentError(result.finish.failure.message, "ABORTED")
    }
    if (signal?.aborted) {
      throw new AgentError("Agent 请求已取消", "ABORTED")
    }
  }

  private textOf(content: readonly ContentBlock[]): string {
    return content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("")
  }
}

export default AgentLoop
