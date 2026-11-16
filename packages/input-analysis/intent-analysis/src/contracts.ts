import { z } from "zod"
import { INTENT_CATALOG, type IntentId } from "./intent-catalog.js"

const INTENT_IDS = INTENT_CATALOG.map((intent) => intent.id) as [IntentId, ...IntentId[]]

export const IntentAnalysisInputSchema = z.object({
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

/** 模型必须返回一个目录内的意图和 0 到 1 的自身置信度。 */
export const IntentAnalysisResultSchema = z.object({
  intent: z.enum(INTENT_IDS),
  confidence: z.number().min(0).max(1),
})

export type IntentAnalysisInput = z.input<typeof IntentAnalysisInputSchema>
export type ParsedIntentAnalysisInput = z.output<typeof IntentAnalysisInputSchema>
export type IntentAnalysisResult = z.infer<typeof IntentAnalysisResultSchema>
