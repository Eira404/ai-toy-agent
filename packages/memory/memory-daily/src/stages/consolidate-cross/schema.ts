import { z } from "zod"

/**
 * 阶段二的两个结构化输出 Schema：分组 + 组内整合。
 */

/** 分组输出：一个分组是候选 ID 的集合。 */
export const GroupingOutputSchema = z
  .object({
    groups: z.array(
      z
        .object({
          candidateIds: z.array(z.string().min(1)).min(1),
        })
        .strict(),
    ),
  })
  .strict()

export type GroupingOutput = z.infer<typeof GroupingOutputSchema>
export const groupingJsonSchema = GroupingOutputSchema.toJSONSchema() as unknown as Readonly<
  Record<string, unknown>
>

const CandidateSchema = z
  .object({
    title: z.string().trim().min(1),
    summary: z.string().trim().min(1),
    body: z.string().trim().min(1),
  })
  .strict()

/** 组内整合输出：一组候选整合成一条或多条。 */
export const CrossConsolidationOutputSchema = z
  .object({
    memories: z.array(CandidateSchema).min(1),
  })
  .strict()

export type CrossConsolidationOutput = z.infer<typeof CrossConsolidationOutputSchema>
export const crossConsolidationJsonSchema = CrossConsolidationOutputSchema.toJSONSchema() as unknown as Readonly<
  Record<string, unknown>
>
