import { z } from "zod"

/**
 * 阶段一的结构化输出 Schema：一个 Session 的 Fast 整合成一条或多条候选。
 *
 * LLM 只输出 title/summary/body；candidateTime、sourceFastIds 由程序附加。
 * `.strict()` 拒绝任何额外字段。
 */
const CandidateSchema = z
  .object({
    title: z.string().trim().min(1),
    summary: z.string().trim().min(1),
    body: z.string().trim().min(1),
  })
  .strict()

export const SessionConsolidationOutputSchema = z
  .object({
    memories: z.array(CandidateSchema).min(1),
  })
  .strict()

export type SessionConsolidationOutput = z.infer<typeof SessionConsolidationOutputSchema>

/** 与 zod schema 对应的 JSON Schema，用于 `toy-llm` 的 responseFormat。 */
export const sessionConsolidationJsonSchema = SessionConsolidationOutputSchema.toJSONSchema() as unknown as Readonly<
  Record<string, unknown>
>
