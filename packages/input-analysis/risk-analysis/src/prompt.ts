import { RISK_CATEGORY_CATALOG, RISK_CONTEXT_CATALOG, RISK_LEVEL_CATALOG } from "./risk-catalog.js"
import type { JevQuestions } from "toy-jev"

export const RISK_CATEGORY_QUESTION_PREFIX = "category_"

export function createRiskAnalysisQuestions(): JevQuestions {
  const categoryQuestions = Object.fromEntries(
    RISK_CATEGORY_CATALOG.filter((category) => category.id !== "none").map((category) => [
      `${RISK_CATEGORY_QUESTION_PREFIX}${category.id}`,
      {
        type: "noul" as const,
        instructions: `结合 History 判断 Query 是否涉及“${category.name}”风险。${category.description} 只判断是否涉及该类别，不要因为内容是教育、新闻或虚构场景就忽略类别。`,
      },
    ]),
  )

  return {
    ...categoryQuestions,
    context: {
      type: "choice",
      instructions:
        "结合 History 如果 Query 涉及任一风险类别，判断其主要风险上下文；该结果在无风险时会被调用方忽略。",
      criteria: Object.fromEntries(
        RISK_CONTEXT_CATALOG.map((context) => [
          context.id,
          `${context.name}：${context.description} 示例：${context.examples}`,
        ]),
      ),
    },
    level: {
      type: "choice",
      instructions:
        "结合 History 如果 Query 涉及任一风险类别，判断整体风险等级；该结果在无风险时会被调用方忽略。",
      criteria: Object.fromEntries(
        RISK_LEVEL_CATALOG.filter((level) => level.id !== "none").map((level) => [
          level.id,
          `${level.name}：${level.description}`,
        ]),
      ),
    },
  }
}
