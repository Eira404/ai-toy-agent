import { z } from "zod"

/**
 * Fast 提取的结构化输出 Schema。
 *
 * LLM 只输出 `title`、`summary`、`body`；ID、来源、时间由 `toy-memory-fast`
 * 程序添加。`.strict()` 拒绝任何额外字段（禁止模型夹带状态操作）。
 */

/** 单条记忆草稿：三个字段各自非空，body 为 Markdown 无序列表。 */
export const FastDraftSchema = z
  .object({
    title: z.string().trim().min(1),
    summary: z.string().trim().min(1),
    body: z.string().trim().min(1),
  })
  .strict()

/** 一次提取的完整输出：零到多条草稿。 */
export const FastExtractionOutputSchema = z
  .object({
    memories: z.array(FastDraftSchema),
  })
  .strict()

export type FastExtractionOutput = z.infer<typeof FastExtractionOutputSchema>
export type ExtractedDraft = z.infer<typeof FastDraftSchema>

/**
 * 与 `FastExtractionOutputSchema` 对应的 JSON Schema，
 * 用于 `toy-llm` 的 `responseFormat: { type: "json_schema", ... }`。
 */
export const fastExtractionJsonSchema = FastExtractionOutputSchema.toJSONSchema() as unknown as Readonly<
  Record<string, unknown>
>
