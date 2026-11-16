import { z } from "zod"
import {
  RISK_CATEGORY_CATALOG,
  RISK_CONTEXT_CATALOG,
  RISK_LEVEL_CATALOG,
  type RiskCategoryId,
  type RiskContextId,
  type RiskLevelId,
} from "./risk-catalog.js"

const RISK_CATEGORY_IDS = RISK_CATEGORY_CATALOG.filter((category) => category.id !== "none").map(
  (category) => category.id,
) as [Exclude<RiskCategoryId, "none">, ...Exclude<RiskCategoryId, "none">[]]
const RISK_CONTEXT_IDS = ["none", ...RISK_CONTEXT_CATALOG.map((context) => context.id)] as [
  "none",
  ...RiskContextId[],
]
const RISK_LEVEL_IDS = RISK_LEVEL_CATALOG.map((level) => level.id) as [
  RiskLevelId,
  ...RiskLevelId[],
]

export const RiskAnalysisInputSchema = z.object({
  query: z.string().trim().min(1, "Query 不能为空"),
  history: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string().trim().min(1),
      }),
    )
    .default([]),
})

export const RiskAnalysisResultSchema = z
  .object({
    categories: z.array(z.enum(RISK_CATEGORY_IDS)).default([]),
    context: z.enum(RISK_CONTEXT_IDS),
    level: z.enum(RISK_LEVEL_IDS),
  })
  .superRefine((result, context) => {
    const uniqueCategories = new Set(result.categories)
    if (uniqueCategories.size !== result.categories.length) {
      context.addIssue({
        code: "custom",
        path: ["categories"],
        message: "风险类别不能重复",
      })
    }

    if (result.categories.length === 0 && (result.context !== "none" || result.level !== "none")) {
      context.addIssue({
        code: "custom",
        message: "无风险类别时，风险上下文和等级必须都是 none",
      })
    }

    if (result.categories.length > 0 && (result.context === "none" || result.level === "none")) {
      context.addIssue({
        code: "custom",
        message: "存在风险类别时，风险上下文和等级不能是 none",
      })
    }
  })

export type RiskAnalysisInput = z.input<typeof RiskAnalysisInputSchema>
export type ParsedRiskAnalysisInput = z.output<typeof RiskAnalysisInputSchema>
export type RiskAnalysisResult = z.infer<typeof RiskAnalysisResultSchema>
