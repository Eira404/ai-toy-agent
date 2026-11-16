import { z } from "zod"
import { EMOTION_CATALOG, type EmotionId } from "./emotion-catalog.js"

const EMOTION_IDS = EMOTION_CATALOG.map((emotion) => emotion.id) as [EmotionId, ...EmotionId[]]

export const EmotionAnalysisInputSchema = z.object({
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
export const EmotionAnalysisResultSchema = z.object({
  emotion: z.enum(EMOTION_IDS),
  confidence: z.number().min(0).max(1),
})

export type EmotionAnalysisInput = z.input<typeof EmotionAnalysisInputSchema>
export type ParsedEmotionAnalysisInput = z.output<typeof EmotionAnalysisInputSchema>
export type EmotionAnalysisResult = z.infer<typeof EmotionAnalysisResultSchema>
