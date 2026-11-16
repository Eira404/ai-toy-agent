import type { Context } from "cordis"
import type { TurnPreprocessingNodeContext } from "toy-agent-loop"
import { LlmSupport, type LlmSupportConfig } from "toy-model-support"
import {
  type QueryAnalysisInput,
  type QueryAnalysisResult,
  QueryAnalysisInputSchema,
  QueryAnalysisResultSchema,
} from "./contracts.js"
import { createSystemPrompt, createUserMessage } from "./prompt.js"

export { PRIMARY_DOMAIN_CATALOG, PRIMARY_DOMAIN_NAMES } from "./domain-catalog.js"
export type { PrimaryDomain } from "./domain-catalog.js"
export { QueryAnalysisResultSchema }

export type QueryAnalysisConfig = LlmSupportConfig

declare module "cordis" {
  interface Context {
    queryAnalysis: ToyQueryAnalysis
  }
}

/**
 * Query 改写与一级领域分析服务，向 Agent Loop 的 preprocessing 注册名为 `queryAnalysis` 的节点。
 */
export class ToyQueryAnalysis extends LlmSupport<QueryAnalysisInput, QueryAnalysisResult> {
  static override inject = ["agentLoop", ...super.inject]

  constructor(ctx: Context, config: QueryAnalysisConfig = {}) {
    super(ctx, "queryAnalysis", config)

    ctx.effect(
      () =>
        ctx.agentLoop.preprocessing.register({
          name: "queryAnalysis",
          order: 200,
          process: ({ message, history, signal }: TurnPreprocessingNodeContext) =>
            this.analyze({ query: message, history: [...history] }, signal),
        }),
      "query.register",
    )
  }

  override analyze(input: QueryAnalysisInput, signal?: AbortSignal): Promise<QueryAnalysisResult> {
    const parsedInput = QueryAnalysisInputSchema.parse(input)
    return this._analyze({
      schema: QueryAnalysisResultSchema,
      systemMessage: createSystemPrompt(parsedInput.history.length > 0),
      userMessage: createUserMessage(parsedInput),
      ...(signal === undefined ? {} : { signal }),
    })
  }
}

export default ToyQueryAnalysis
