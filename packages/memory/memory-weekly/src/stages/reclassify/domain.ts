import type { LongDomain } from "toy-memory-long"

/** 六个 Domain 的固定枚举（JEV choice 候选项）。 */
export const LONG_DOMAINS: readonly LongDomain[] = [
  "self",
  "person",
  "project",
  "topic",
  "entity",
  "event",
]

/** Domain 判据：JEV choice 的 criteria，含适合与不适合边界（文档 8.1）。 */
export const DOMAIN_CRITERIA: Readonly<Record<LongDomain, string>> = {
  self: "用户自身的特征、偏好、习惯、个人信息和当前状态；不应存具体熟人的完整信息、独立事件经过、项目全部进展",
  person: "用户现实社交关系中可识别的具体人物；不应存仅因提及公众人物而建立的人物块、无法识别的陌生人",
  project: "有明确目标、成果和推进过程的持续事项；不应存泛知识领域、一次性事件、无明确目标的兴趣",
  topic: "知识领域、抽象概念、技能和持续兴趣；不应存具体人物、地点、餐厅、物品的完整信息",
  entity: "具有独立身份、可持续积累信息的非人物实体；不应存抽象概念、一般偏好、无独立价值的临时提及",
  event: "有明确发生边界、值得长期保留的经历或事件；不应存持续状态、一般知识、无独立价值的日常动作",
}
