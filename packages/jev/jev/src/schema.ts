import { z } from "zod"

/** 从候选项中选择一个标签的问题。 */
export const JevChoiceQuestionSchema = z.object({
  type: z.literal("choice"),
  instructions: z.string().min(1),
  criteria: z
    .record(z.string().min(1), z.string().min(1))
    .refine((value) => Object.keys(value).length > 0, "choice 问题至少需要一个候选项"),
})

/** 按一组文字标准返回数值评分的问题。 */
export const JevScoreQuestionSchema = z.object({
  type: z.literal("score"),
  instructions: z.string().min(1),
  criteria: z.array(z.string().min(1)).min(1),
})

/** 返回 0 到 1 连续值的问题。 */
export const JevNoulQuestionSchema = z.object({
  type: z.literal("noul"),
  instructions: z.string().min(1),
})

export const JevQuestionSchema = z.discriminatedUnion("type", [
  JevChoiceQuestionSchema,
  JevScoreQuestionSchema,
  JevNoulQuestionSchema,
])

export const JevQuestionsSchema = z
  .record(z.string().min(1), JevQuestionSchema)
  .refine((value) => Object.keys(value).length > 0, "至少需要提供一个 JEV 问题")

export const JevChoiceAnswerSchema = z.object({
  type: z.literal("choice"),
  choice: z.string(),
  confidence: z.number(),
  probabilities: z.record(z.string(), z.number()),
})

export const JevScoreAnswerSchema = z.object({
  type: z.literal("score"),
  score: z.number(),
  confidence: z.number(),
  legend: z.record(z.string(), z.string()),
  probabilities: z.record(z.string(), z.number()),
})

export const JevNoulAnswerSchema = z.object({
  type: z.literal("noul"),
  noul: z.number(),
})

export const JevAnswerSchema = z.discriminatedUnion("type", [
  JevChoiceAnswerSchema,
  JevScoreAnswerSchema,
  JevNoulAnswerSchema,
])

export const JevResponseSchema = z.object({
  answers: z.record(z.string(), JevAnswerSchema),
  model: z.string().min(1),
  usage: z
    .object({
      input_tokens: z.number().nonnegative(),
      output_tokens: z.number().nonnegative(),
    })
    .optional(),
})

/** 通过 type 区分的单个问题定义。 */
export type JevQuestion = z.infer<typeof JevQuestionSchema>
/** 一次请求中按名称索引的问题集合。 */
export type JevQuestions = z.infer<typeof JevQuestionsSchema>
/** 与相同 type 的问题对应的结构化答案。 */
export type JevAnswer = z.infer<typeof JevAnswerSchema>
/** 评估结果，包含命名答案、模型名和可选用量。 */
export type JevResponse = z.infer<typeof JevResponseSchema>
