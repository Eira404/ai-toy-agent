import type { Context } from "cordis"
import type { TurnPreprocessingNodeContext } from "toy-agent-loop"
import {
  IntentAnalysisInputSchema,
  IntentAnalysisResultSchema,
  type IntentAnalysisInput,
  type IntentAnalysisResult,
  type ParsedIntentAnalysisInput,
} from "./contracts.js"
import { INTENT_CATALOG } from "./intent-catalog.js"
import { QuestionSupport, type QuestionSupportConfig } from "toy-model-support"

export { INTENT_CATALOG, IntentAnalysisInputSchema, IntentAnalysisResultSchema }

/** 意图分析策略配置；默认走 LLM，可显式切换到 JEV。 */
export type IntentAnalysisConfig = QuestionSupportConfig

declare module "cordis" {
  interface Context {
    intentAnalysis: ToyIntentAnalysis
  }
}

/**
 * 可选 LLM/JEV 的意图分析服务。
 *
 * 调用方式：先加载所选策略对应的 Runtime（`toy-llm` 或 `toy-jev`），再加载本服务。
 * 它会向 Agent Loop 的 preprocessing 注册名为 `intent` 的节点。
 */
export class ToyIntentAnalysis extends QuestionSupport<IntentAnalysisInput, IntentAnalysisResult> {
  static inject = ["agentLoop"]

  constructor(ctx: Context, config: IntentAnalysisConfig = {}) {
    super(ctx, "intentAnalysis", config)

    ctx.effect(
      () =>
        ctx.agentLoop.preprocessing.register({
          name: "intent",
          order: 200,
          process: ({ message, history, signal }: TurnPreprocessingNodeContext) =>
            this.analyze({ query: message, history: [...history] }, signal),
        }),
      "intentAnalysis.register",
    )
  }

  /** 校验当前 Query 和上一轮对话后，调用配置的分类策略。 */
  override analyze(
    input: IntentAnalysisInput,
    signal?: AbortSignal,
  ): Promise<IntentAnalysisResult> {
    const parsedInput = IntentAnalysisInputSchema.parse(input)
    return this._analyze({
      state: createJevIntentState(parsedInput),
      name: "intent",
      instructions: "结合上一轮对话理解指代，判断当前用户 Query 的主要意图，只选择一个候选项。",
      schema: IntentAnalysisResultSchema,
      type: "choice",
      criteria: Object.fromEntries(INTENT_CATALOG.map((intent) => [intent.id, intent.description])),
      ...(signal === undefined ? {} : { signal }),
    })
  }
}

function createJevIntentState(input: ParsedIntentAnalysisInput): string {
  const history = input.history.map(
    (message) => `${message.role === "user" ? "上一轮用户" : "上一轮助手"}：${message.content}`,
  )
  return [...history, `当前用户：${input.query}`].join("\n")
}

export default ToyIntentAnalysis
