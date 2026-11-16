import type { Context } from "cordis"
import type { TurnPreprocessingNodeContext } from "toy-agent-loop"
import {
  EmotionAnalysisInputSchema,
  type EmotionAnalysisInput,
  type EmotionAnalysisResult,
  EmotionAnalysisResultSchema,
  type ParsedEmotionAnalysisInput,
} from "./contracts.js"
import { JevSupport, type JevSupportConfig } from "toy-model-support"
import { EMOTION_CATALOG } from "./emotion-catalog.js"

export type EmotionAnalysisConfig = JevSupportConfig

declare module "cordis" {
  interface Context {
    emotionAnalysis: ToyEmotionAnalysis
  }
}

/**
 * 情绪分析服务，向 Agent Loop 的 preprocessing 注册名为 `emotion` 的节点。
 *
 * 调用方式：先加载 `toy-jev`，再加载本服务。
 */
export class ToyEmotionAnalysis extends JevSupport<EmotionAnalysisInput, EmotionAnalysisResult> {
  static override inject = ["agentLoop", ...super.inject]

  constructor(ctx: Context, config: EmotionAnalysisConfig = {}) {
    super(ctx, "emotionAnalysis", config)

    ctx.effect(
      () =>
        ctx.agentLoop.preprocessing.register({
          name: "emotion",
          order: 200,
          process: ({ message, history, signal }: TurnPreprocessingNodeContext) =>
            this.analyze({ query: message, history: [...history] }, signal),
        }),
      "emotionAnalysis.register",
    )
  }

  /** 使用显式情绪词生成一个保守的粗粒度判断。 */
  override analyze(
    input: EmotionAnalysisInput,
    signal?: AbortSignal,
  ): Promise<EmotionAnalysisResult> {
    const parsedInput = EmotionAnalysisInputSchema.parse(input)
    return this.invokeJevChoice({
      state: createJevEmotionState(parsedInput),
      name: "emotion",
      instructions: "结合上一轮对话理解指代，判断当前用户 Query 的主要情绪，只选择一个候选项。",
      schema: EmotionAnalysisResultSchema,
      criteria: Object.fromEntries(
        EMOTION_CATALOG.map((emotion) => [emotion.id, emotion.description]),
      ),
      ...(signal === undefined ? {} : { signal }),
    })
  }
}

function createJevEmotionState(input: ParsedEmotionAnalysisInput): string {
  const history = input.history.map(
    (message) => `${message.role === "user" ? "上一轮用户" : "上一轮助手"}：${message.content}`,
  )
  return [...history, `当前用户：${input.query}`].join("\n")
}

export default ToyEmotionAnalysis
