import { z } from "zod"

/** 目标决策：更新某个已有块，或创建新块。 */
export const TargetDecisionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("EXISTING"), blockId: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("NEW") }).strict(),
])

export type TargetDecision = z.infer<typeof TargetDecisionSchema>
export const targetDecisionJsonSchema = TargetDecisionSchema.toJSONSchema() as unknown as Readonly<
  Record<string, unknown>
>
