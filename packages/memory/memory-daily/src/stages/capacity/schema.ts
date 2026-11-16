import { z } from "zod"

/** 压缩输出：单字段缩短后的内容。 */
export const ShortenSchema = z
  .object({
    content: z.string().trim().min(1),
  })
  .strict()

export type ShortenOutput = z.infer<typeof ShortenSchema>
export const shortenJsonSchema = ShortenSchema.toJSONSchema() as unknown as Readonly<
  Record<string, unknown>
>

// ============ 阶段五 · 第一遍（overview 溢出分配） ============

/** 移出内容的去向：更新已有 detail 或从 overview 创建新 detail。 */
export const OverviewOverflowOperationSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("UPDATE_EXISTING_DETAIL"),
      detailId: z.string().trim().min(1),
      summary: z.string().trim().min(1),
      body: z.string().trim().min(1),
    })
    .strict(),
  z
    .object({
      type: z.literal("CREATE_FROM_OVERVIEW"),
      summary: z.string().trim().min(1),
      body: z.string().trim().min(1),
    })
    .strict(),
])

/** 第一遍输出：新的 overview body + 多个 detail 操作。 */
export const OverviewCapacitySchema = z
  .object({
    overviewBody: z.string().trim().min(1),
    detailOperations: z.array(OverviewOverflowOperationSchema),
  })
  .strict()

export type OverviewCapacity = z.infer<typeof OverviewCapacitySchema>
export const overviewCapacityJsonSchema = OverviewCapacitySchema.toJSONSchema() as unknown as Readonly<
  Record<string, unknown>
>

// ============ 阶段五 · 第二遍（detail 超限处理） ============

const DetailSplitPartSchema = z
  .object({
    summary: z.string().trim().min(1),
    body: z.string().trim().min(1),
  })
  .strict()

/** 超限 detail 的处理方式：重写或拆分。 */
export const DetailCapacityOperationSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("REWRITE"),
      detailId: z.string().trim().min(1),
      summary: z.string().trim().min(1),
      body: z.string().trim().min(1),
    })
    .strict(),
  z
    .object({
      type: z.literal("SPLIT"),
      detailId: z.string().trim().min(1),
      parts: z.array(DetailSplitPartSchema).min(2),
    })
    .strict(),
])

/** 第二遍输出：多个 REWRITE / SPLIT 操作。 */
export const DetailCapacitySchema = z
  .object({
    operations: z.array(DetailCapacityOperationSchema),
  })
  .strict()

export type DetailCapacity = z.infer<typeof DetailCapacitySchema>
export const detailCapacityJsonSchema = DetailCapacitySchema.toJSONSchema() as unknown as Readonly<
  Record<string, unknown>
>
