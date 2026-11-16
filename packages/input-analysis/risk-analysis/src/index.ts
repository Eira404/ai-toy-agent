import type { Context } from "cordis"
import type { TurnPreprocessingNodeContext } from "toy-agent-loop"
import {
  type RiskAnalysisResult,
  type RiskAnalysisInput,
  type ParsedRiskAnalysisInput,
  RiskAnalysisInputSchema,
  RiskAnalysisResultSchema,
} from "./contracts.js"
import { JevSupport, type JevSupportConfig } from "toy-model-support"
import { createRiskAnalysisQuestions, RISK_CATEGORY_QUESTION_PREFIX } from "./prompt.js"
import { RISK_CATEGORY_CATALOG } from "./risk-catalog.js"

const CATEGORY_THRESHOLD = 0.5

export type RiskAnalysisConfig = JevSupportConfig

declare module "cordis" {
  interface Context {
    riskAnalysis: ToyRiskAnalysis
  }
}

/**
 * 风险分析服务，向 Agent Loop 的 preprocessing 注册名为 `risk` 的节点。
 *
 * 调用方式：先加载 `toy-jev`，再加载本服务。
 */
export class ToyRiskAnalysis extends JevSupport<RiskAnalysisInput, RiskAnalysisResult> {
  static override inject = ["agentLoop", ...super.inject]

  constructor(ctx: Context, config: RiskAnalysisConfig = {}) {
    super(ctx, "riskAnalysis", config)

    ctx.effect(
      () =>
        ctx.agentLoop.preprocessing.register({
          name: "risk",
          order: 200,
          process: ({ message, history, signal }: TurnPreprocessingNodeContext) =>
            this.analyze({ query: message, history: [...history] }, signal),
        }),
      "riskAnalysis.register",
    )
  }

  /** 用多个 noul 问题筛选命中类别，再投影 context/level 到扁平结果。 */
  override async analyze(
    input: RiskAnalysisInput,
    signal?: AbortSignal,
  ): Promise<RiskAnalysisResult> {
    const parsedInput = RiskAnalysisInputSchema.parse(input)
    const response = await this.invokeJevRaw(
      createJevState(parsedInput),
      createRiskAnalysisQuestions(),
      signal,
    )
    const categories = RISK_CATEGORY_CATALOG.filter((category) => category.id !== "none")
      .filter((category) => {
        const answer = response.answers[`${RISK_CATEGORY_QUESTION_PREFIX}${category.id}`]
        if (answer?.type !== "noul") {
          throw new Error(`JEV 风险分析响应缺少 ${category.id} noul 答案`)
        }
        return answer.noul >= CATEGORY_THRESHOLD
      })
      .map((category) => category.id)

    if (categories.length === 0) {
      return { categories: [], context: "none", level: "none" }
    }

    const context = response.answers.context
    const level = response.answers.level
    if (context?.type !== "choice") {
      throw new Error("JEV 风险分析响应缺少 context choice 答案")
    }
    if (level?.type !== "choice") {
      throw new Error("JEV 风险分析响应缺少 level choice 答案")
    }

    return RiskAnalysisResultSchema.parse({
      categories,
      context: context.choice,
      level: level.choice,
    })
  }
}

function createJevState(input: ParsedRiskAnalysisInput): string {
  const history = input.history
    .map(
      (message) => `${message.role === "user" ? "上一轮用户" : "上一轮助手"}：${message.content}`,
    )
    .join("\n")
  return [`<HISTORY>\n${history}\n</HISTORY>`, `<QUERY>\n${input.query}\n</QUERY>`].join("\n")
}

export default ToyRiskAnalysis
