import type { Context } from "cordis"
import type { TurnPreprocessingNodeContext } from "toy-agent-loop"
import { JevSupport, type JevSupportConfig } from "toy-model-support"
import { QueryAnalysisResultSchema } from "toy-query-analysis"
import {
  getSubdomainCandidates,
  type ParsedSubdomainAnalysisInput,
  SubdomainAnalysisInputSchema,
  SubdomainScoreSchema,
  type SubdomainAnalysisInput,
  type SubdomainAnalysisResult,
  SubdomainAnalysisResultSchema,
} from "./contracts.js"
import { createSubdomainAnalysisQuestions, SUBDOMAIN_QUESTION_PREFIX } from "./prompt.js"

export type SubdomainAnalysisConfig = JevSupportConfig

declare module "cordis" {
  interface Context {
    subdomainAnalysis: ToySubdomainAnalysis
  }
}

const CLOSE_SCORE_DELTA = 0.5
const MAX_SELECTED_SUBDOMAINS = 3

/**
 * 子领域打分服务，向 Agent Loop 的 preprocessing 注册名为 `subdomain` 的节点。
 * 依赖 `queryAnalysis` 节点的输出（通过 `dependsOn` + `upstream`）。
 */
export class ToySubdomainAnalysis extends JevSupport<
  SubdomainAnalysisInput,
  SubdomainAnalysisResult
> {
  static override inject = ["agentLoop", ...super.inject]

  constructor(ctx: Context, config: SubdomainAnalysisConfig = {}) {
    super(ctx, "subdomainAnalysis", config)

    ctx.effect(
      () =>
        ctx.agentLoop.preprocessing.register({
          name: "subdomain",
          dependsOn: ["queryAnalysis"],
          order: 200,
          process: ({ upstream, history, signal }: TurnPreprocessingNodeContext) => {
            const queryAnalysis = QueryAnalysisResultSchema.parse(upstream.queryAnalysis)

            return this.analyze(
              {
                query: queryAnalysis.rewrittenQuery,
                history: [...history],
                primaryDomain: queryAnalysis.primaryDomain,
                secondaryDomains: queryAnalysis.secondaryDomains,
              },
              signal,
            )
          },
        }),
      "subdomainAnalysis.register",
    )
  }

  override async analyze(
    input: SubdomainAnalysisInput,
    signal?: AbortSignal,
  ): Promise<SubdomainAnalysisResult> {
    const parsedInput = SubdomainAnalysisInputSchema.parse(input)
    const candidates = getSubdomainCandidates(parsedInput)
    const response = await this.invokeJevRaw(
      createJevState(parsedInput),
      createSubdomainAnalysisQuestions(parsedInput),
      signal,
    )
    const scores = candidates.map((candidate, index) => {
      const answer = response.answers[`${SUBDOMAIN_QUESTION_PREFIX}${index}`]
      if (answer?.type !== "score") {
        throw new Error(`JEV 子领域分析响应缺少第 ${index + 1} 个 score 答案`)
      }

      return SubdomainScoreSchema.parse({
        domain: candidate.primaryDomain,
        name: candidate.name,
        score: answer.score,
      })
    })
    const parsedScores = SubdomainScoreSchema.array().min(1).parse(scores)
    const tCandidates = new Set(
      candidates.map((candidate) => `${candidate.primaryDomain}\u0000${candidate.name}`),
    )

    for (const score of parsedScores) {
      if (!tCandidates.has(`${score.domain}\u0000${score.name}`)) {
        throw new Error(`子领域不属于 Query 分析得到的一级领域：${score.domain} > ${score.name}`)
      }
    }

    const sortedScores = [...parsedScores].sort((left, right) => right.score - left.score)
    const highestScore = sortedScores[0]!.score
    const subdomains = sortedScores
      .filter((candidate) => highestScore - candidate.score <= CLOSE_SCORE_DELTA)
      .slice(0, MAX_SELECTED_SUBDOMAINS)

    return SubdomainAnalysisResultSchema.parse({ subdomains })
  }
}

function createJevState(input: ParsedSubdomainAnalysisInput): string {
  const history = input.history
    .map(
      (message) => `${message.role === "user" ? "上一轮用户" : "上一轮助手"}：${message.content}`,
    )
    .join("\n")
  return [`<HISTORY>\n${history}\n</HISTORY>`, `<QUERY>\n${input.query}\n</QUERY>`].join("\n")
}

export default ToySubdomainAnalysis
