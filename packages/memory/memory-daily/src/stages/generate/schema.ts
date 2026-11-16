import { z } from "zod"

/** 细节操作：更新（重新生成 summary/body）或删除。 */
const DetailOperationSchema = z
  .object({
    detailId: z.string().min(1),
    operation: z.discriminatedUnion("type", [
      z
        .object({
          type: z.literal("UPDATE"),
          summary: z.string().trim().min(1),
          body: z.string().trim().min(1),
        })
        .strict(),
      z.object({ type: z.literal("DELETE") }).strict(),
    ]),
  })
  .strict()

/** 阶段四内容生成输出：一个目标块的完整新内容 + 可选细节操作。 */
export const BlockGenerationSchema = z
  .object({
    title: z.string().trim().min(1),
    aliases: z.array(z.string().trim().min(1)),
    summary: z.string().trim().min(1),
    overviewBody: z.string().trim().min(1),
    detailOperations: z.array(DetailOperationSchema),
  })
  .strict()

export type BlockGeneration = z.infer<typeof BlockGenerationSchema>
export const blockGenerationJsonSchema = BlockGenerationSchema.toJSONSchema() as unknown as Readonly<
  Record<string, unknown>
>
