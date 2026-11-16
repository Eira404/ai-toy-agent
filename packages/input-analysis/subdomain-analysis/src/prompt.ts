import type { JevQuestions } from "toy-jev"
import { type ParsedSubdomainAnalysisInput, getSubdomainCandidates } from "./contracts.js"

export const SUBDOMAIN_QUESTION_PREFIX = "subdomain_"

export function createSubdomainAnalysisQuestions(
  input: ParsedSubdomainAnalysisInput,
): JevQuestions {
  return Object.fromEntries(
    getSubdomainCandidates(input).map((domain, index) => [
      `${SUBDOMAIN_QUESTION_PREFIX}${index}`,
      {
        type: "score" as const,
        instructions: `结合 History 判断 Query 与“${domain.primaryDomain} > ${domain.name}”的相关程度。领域说明：${domain.description}`,
        criteria: ["完全不相关", "弱相关", "明确相关", "高度相关且是核心主题"],
      },
    ]),
  )
}
