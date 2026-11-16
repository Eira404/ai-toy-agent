import { z } from "zod"

/** 初始化时的四档语义重要性；映射至 I 的数值由 forgetting.ts 决定。 */
export const ImportanceLevelSchema = z.enum(["low", "normal", "high", "core"])
/** 重要性判断标签，不是生命周期；core 也会衰减。 */
export type ImportanceLevel = z.infer<typeof ImportanceLevelSchema>

/** 与 feedback 包的 FeedbackType 契约对应，既用于模型输出也用于数值增益选择。 */
export const FeedbackTypeSchema = z.enum([
  "no_user_signal",
  "confirmed",
  "supplemented",
  "follow_up",
  "corrected",
  "irrelevant",
  "uncertain",
])

const turnNo = z.number().int().positive().safe()
const evidenceTurnNos = z
  .array(turnNo)
  .min(1)
  .refine((turns) => new Set(turns).size === turns.length, "证据轮次不能重复")

/** 一项可定位到用户轮次的态度证据；无信号用空数组表示，不作为单独 signal。 */
export const FeedbackSignalSchema = z
  .object({
    /** 这项证据支持的态度，不必等于最终归并后的主态度。 */
    feedbackType: FeedbackTypeSchema.exclude(["no_user_signal"]),
    /** 支持此项态度的用户轮次，至少一项且不能重复；区间归属由 FeedbackJudge 校验。 */
    evidenceTurnNos,
    /** 简短的用户证据说明，不要求输出模型思考过程。 */
    reason: z.string().trim().min(1).max(1000),
  })
  .strict()

/** judgementVersion=1 的私有 JSON；保留所有信号供后续校验和审计，不输出价值分数。 */
export const JudgementDataSchema = z
  .object({
    /** 最终态度的依据；纠错覆盖主态度时使用首项纠错依据。 */
    reason: z.string().trim().min(1).max(1000),
    /** 全部有证据的态度；无用户信号时为空数组。 */
    signals: z.array(FeedbackSignalSchema),
  })
  .strict()

/** 模型的候选结果；尚需证据校验和纠错优先归并，不能直接作为 FeedbackJudgement 落库。 */
export const FeedbackOutputSchema = z
  .object({
    /** 模型选择的主要态度；程序检测到 corrected 信号时会覆盖正向选择。 */
    primaryFeedbackType: FeedbackTypeSchema,
    reason: z.string().trim().min(1).max(1000),
    signals: z.array(FeedbackSignalSchema),
  })
  .strict()

/** 未归并的态度模型结果，仅由判断器内部处理。 */
export type FeedbackOutput = z.infer<typeof FeedbackOutputSchema>
/** 保存于 FeedbackJudgement.judgementData 的版本化结构。 */
export type JudgementData = z.infer<typeof JudgementDataSchema>

/** 模型只选择重要性等级；reason 供解释判断，不直接参与数值公式。 */
export const ImportanceOutputSchema = z
  .object({
    importance: ImportanceLevelSchema,
    reason: z.string().trim().min(1).max(1000),
  })
  .strict()

/** 正文变化模型结果：只分类，不改写正文，也不输出强化数值。 */
export const ContentChangeOutputSchema = z
  .object({
    changeType: z.enum(["unchanged", "rephrased", "supplemented", "state_updated", "corrected"]),
    reason: z.string().trim().min(1).max(1000),
  })
  .strict()
/** unchanged/rephrased/corrected 不强化；supplemented/state_updated 复用补充增益。 */
export type ContentChange = z.infer<typeof ContentChangeOutputSchema>["changeType"]

const identity = { unitId: z.string().min(1), blockId: z.string().min(1) }
const overviewRecall = {
  ...identity,
  unitType: z.literal("overview"),
  recalledContent: z
    .object({ title: z.string(), summary: z.string(), overviewBody: z.string() })
    .strict(),
}
const detailRecall = {
  ...identity,
  unitType: z.literal("detail"),
  recalledContent: z.object({ summary: z.string(), body: z.string() }).strict(),
}
const recallSnapshot = z.discriminatedUnion("unitType", [
  z.object({ ...overviewRecall, turnNo, turnId: z.string().min(1) }),
  z.object({ ...detailRecall, turnNo, turnId: z.string().min(1) }),
])
const judgeContext = {
  recallTurnNos: z.array(turnNo).min(1),
  recallSnapshots: z.array(recallSnapshot).min(1),
  recallAssistantTurns: z.array(z.object({ turnNo, assistantText: z.string() })),
  relevantTurns: z.array(z.object({ turnNo, userText: z.string(), assistantText: z.string() })),
}

/**
 * 与 feedback 的 JudgeSessionInput 判别联合相同；保留检索正文的原字段名称。
 * Schema 校验结构，轮次顺序、单元归属和首次快照一致性在 FeedbackJudge 中进一步检查。
 * signal 由调用方法单独透传，不序列化为模型数据。
 */
export const JudgeSessionInputSchema = z.discriminatedUnion("unitType", [
  z.object({ ...overviewRecall, ...judgeContext }),
  z.object({ ...detailRecall, ...judgeContext }),
])

/** initialize 的单项输入（Daily/Weekly 共用同一形状）；detail 的 title 为父块标题，body 为自身正文。 */
export const ValueUnitInputSchema = z
  .object({
    unitType: z.enum(["overview", "detail"]),
    domain: z.enum(["self", "person", "project", "topic", "entity", "event"]),
    title: z.string().min(1),
    body: z.string().min(1),
  })
  .strict()

/** reinforceUpdated 使用的旧新正文；概述正文在该契约中也叫 body，而非 overviewBody。 */
export const UnitContentSchema = z.discriminatedUnion("unitType", [
  z
    .object({
      unitType: z.literal("overview"),
      title: z.string(),
      summary: z.string(),
      body: z.string(),
    })
    .strict(),
  z.object({ unitType: z.literal("detail"), summary: z.string(), body: z.string() }).strict(),
])
