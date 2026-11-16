import type { Context } from "cordis"
import type {
  PromptSection,
  SystemPromptAssembler,
  TurnBlockingPostNodeContext,
  TurnPreprocessingNodeContext,
} from "toy-agent-loop"
import type { JevQuestions, JevResponse } from "toy-jev"
import { JevSupport, type JevSupportConfig } from "toy-model-support"
import type { TurnHistory } from "toy-session-storage"
import {
  DEFAULT_MODE_CATALOG,
  ENGLISH_PRACTICE_CATALOG,
  INITIAL_MODE_STATE,
  type DefaultMode,
  type EnglishPracticeMode,
  type ModeState,
} from "./mode-catalog.js"
import {
  createJevState,
  deriveModeState,
  ModeAnalysisInputSchema,
  ModeAnalysisResultSchema,
  ModeStateSchema,
  nextEnglishPracticeMode,
  type ModeAnalysisInput,
  type ModeAnalysisResult,
  type ModeSignals,
} from "./contracts.js"

export { DEFAULT_MODE_CATALOG, ENGLISH_PRACTICE_CATALOG, INITIAL_MODE_STATE }
export type { DefaultMode, EnglishPracticeMode, ModeState }
export {
  createJevState,
  deriveModeState,
  ModeAnalysisInputSchema,
  ModeAnalysisResultSchema,
  ModeStateSchema,
  nextEnglishPracticeMode,
}
export type { ModeAnalysisInput, ModeAnalysisResult, ModeSignals }

/** Turn 预处理节点名：模式判断结果进入 `preprocessing.data.mode`。 */
export const MODE_NODE = "mode"
/** blockingPost 节点名：把新模式写回当前 Turn 的 `mode_state` 事件。 */
export const MODE_COMMIT_NODE = "mode-commit"
/** 持久化模式状态的会话事件类型。 */
export const MODE_EVENT_TYPE = "mode_state"

export type ModeAnalysisConfig = JevSupportConfig

declare module "cordis" {
  interface Context {
    modeAnalysis: ToyModeAnalysis
  }
}

/**
 * 模式判断服务：用 JEV 判断「默认 / 英语对练」模式，并向 Agent Loop 注册两个节点：
 * - preprocessing `mode`：从 `previousTurns` 恢复上一轮模式 → JEV 判断四个软信号 → 代码状态机推出新模式；
 * - blockingPost `mode-commit`：把新模式写回 `mode_state` 事件，下一轮可见。
 *
 * 调用方式：先加载 `toy-jev`（注册 Adapter），再加载 `toy-agent-loop` 与本服务。
 */
export class ToyModeAnalysis extends JevSupport<ModeAnalysisInput, ModeAnalysisResult> {
  static override inject = ["agentLoop", ...super.inject]

  constructor(ctx: Context, config: ModeAnalysisConfig = {}) {
    super(ctx, "modeAnalysis", config)

    ctx.effect(
      () =>
        ctx.agentLoop.preprocessing.register({
          name: MODE_NODE,
          order: 100,
          process: ({ message, history, previousTurns, signal }: TurnPreprocessingNodeContext) =>
            this.analyze(
              { query: message, history: [...history], previous: readPreviousMode(previousTurns) },
              signal,
            ),
        }),
      "modeAnalysis.register",
    )

    ctx.effect(
      () =>
        ctx.agentLoop.blockingPost.register({
          name: MODE_COMMIT_NODE,
          process: async ({ preprocessing, appendEvents }: TurnBlockingPostNodeContext) => {
            const mode = ModeAnalysisResultSchema.safeParse(preprocessing[MODE_NODE])
            if (!mode.success) {
              return
            }
            await appendEvents([{ eventType: MODE_EVENT_TYPE, payload: mode.data }])
          },
        }),
      "modeAnalysis.registerCommit",
    )

    const systemPrompt = ctx.reflect.get("systemPrompt") as SystemPromptAssembler | undefined
    if (systemPrompt !== undefined) {
      ctx.effect(() => systemPrompt.registerSection(modeSection()), "modeAnalysis.registerSection")
    }
  }

  /** 用 JEV 判断四个软信号，再由代码状态机推出英语对练状态并推导默认模式。 */
  override async analyze(
    input: ModeAnalysisInput,
    signal?: AbortSignal,
  ): Promise<ModeAnalysisResult> {
    const parsedInput = ModeAnalysisInputSchema.parse(input)
    const response = await this.invokeJevRaw(
      createJevState(parsedInput),
      createModeQuestions(),
      signal,
    )
    const signals: ModeSignals = {
      english: noulOf(response, "english"),
      startContinue: noulOf(response, "startContinue"),
      stop: noulOf(response, "stop"),
      relevantChinese: noulOf(response, "relevantChinese"),
    }
    return deriveModeState(nextEnglishPracticeMode(parsedInput.previous.englishPractice, signals))
  }
}

export default ToyModeAnalysis

// ---------------------------------------------------------------------------
// 模块级辅助
// ---------------------------------------------------------------------------

/** 四个独立、简单的 JEV 信号问题；每个都只判断用户本轮的一个侧面。 */
function createModeQuestions(): JevQuestions {
  return {
    english: {
      type: "noul",
      instructions:
        "判断用户本轮输入是否为交流形式的英文（英文句子、英文提问或英文对话），是则接近 1，否则接近 0。",
    },
    startContinue: {
      type: "noul",
      instructions:
        "判断用户本轮是否明确表达了想开始或继续英语对练（如「我们来练英语吧」「继续」），是则接近 1，否则接近 0。",
    },
    stop: {
      type: "noul",
      instructions:
        "判断用户本轮是否明确表达了不想继续、要结束或退出英语对练，是则接近 1，否则接近 0。",
    },
    relevantChinese: {
      type: "noul",
      instructions:
        "判断用户本轮是否用中文提出与英语学习相关的问题（如询问某个英文表达怎么说、某句中文怎么翻译），是则接近 1，否则接近 0。",
    },
  }
}

/** 读取单个 noul 答案；缺失或类型不符时抛错。 */
function noulOf(response: JevResponse, name: string): number {
  const answer = response.answers[name]
  if (answer?.type !== "noul") {
    throw new Error(`JEV 模式分析缺少 ${name} 的 noul 答案`)
  }
  return answer.noul
}

/** 从上一轮完整 Turn/Event 快照中恢复最近的模式状态；缺失或非法时回退到初始模式。 */
export function readPreviousMode(previousTurns: readonly TurnHistory[]): ModeState {
  for (let i = previousTurns.length - 1; i >= 0; i -= 1) {
    const events = previousTurns[i]?.events ?? []
    for (let j = events.length - 1; j >= 0; j -= 1) {
      const event = events[j]
      if (event?.eventType === MODE_EVENT_TYPE) {
        const parsed = ModeStateSchema.safeParse(event.payload)
        if (parsed.success) {
          return parsed.data
        }
      }
    }
  }
  return { ...INITIAL_MODE_STATE }
}

/** 把模式结果渲染为 system prompt 片段，让主模型按当前模式作答。 */
export function modeSection(): PromptSection {
  return {
    name: "mode-status",
    order: 10,
    render: (context) => {
      const mode = modeResultOf(context.preprocessing.data[MODE_NODE])
      if (mode === null) {
        return ""
      }
      if (mode.englishPractice === "yes") {
        return "当前处于英语对练模式：请用英语回复用户并鼓励用户继续用英语交流；若用户用中文提问，可简要解释后继续引导英语对练。"
      }
      if (mode.englishPractice === "pending-exit") {
        return "用户似乎准备退出英语对练，但尚未明确结束：保持以英语为主，可自然询问是否继续。"
      }
      return ""
    },
  }
}

function modeResultOf(value: unknown): ModeState | null {
  if (typeof value !== "object" || value === null) {
    return null
  }
  const candidate = value as Partial<ModeState>
  return typeof candidate.defaultMode === "string" &&
    typeof candidate.englishPractice === "string"
    ? (candidate as ModeState)
    : null
}
