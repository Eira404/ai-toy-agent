import { z } from "zod"
import { PRIMARY_DOMAIN_NAMES } from "./domain-catalog.js"

export const QueryAnalysisInputSchema = z.object({
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

export const QueryAnalysisResultSchema = z
  .object({
    rewrittenQuery: z
      .string()
      .trim()
      .min(1)
      .describe("结合历史上下文完成代词消解后的 Query；没有代词时保持原文不变"),
    primaryDomain: z.enum(PRIMARY_DOMAIN_NAMES).describe("与当前 Query 最相关的一个一级领域"),
    secondaryDomains: z
      .array(z.enum(PRIMARY_DOMAIN_NAMES.filter((d) => d !== "其他")))
      .default([])
      .describe("只有 Query 确实跨越不同一级领域时才返回；通常为空数组"),
  })
  .superRefine((result, context) => {
    const seen = new Set<string>()

    result.secondaryDomains.forEach((domain, index) => {
      if (domain === result.primaryDomain) {
        context.addIssue({
          code: "custom",
          path: ["secondaryDomains", index],
          message: "副领域不能与主领域相同",
        })
      }

      if (seen.has(domain)) {
        context.addIssue({
          code: "custom",
          path: ["secondaryDomains", index],
          message: "副领域不能重复",
        })
      }

      seen.add(domain)
    })
  })

export type QueryAnalysisInput = z.input<typeof QueryAnalysisInputSchema>
export type ParsedQueryAnalysisInput = z.output<typeof QueryAnalysisInputSchema>
export type QueryAnalysisResult = z.infer<typeof QueryAnalysisResultSchema>
