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

/** Domain 判据：JEV choice 的 criteria。 */
export const DOMAIN_CRITERIA: Readonly<Record<LongDomain, string>> = {
  self: "用户自身的特征、偏好、习惯、个人信息和当前状态",
  person: "用户现实社交关系中可识别的具体人物",
  project: "有明确目标、成果和推进过程的持续事项",
  topic: "知识领域、抽象概念、技能和持续兴趣",
  entity: "具有独立身份、可持续积累信息的非人物实体",
  event: "有明确发生边界、值得长期保留的经历或事件",
}
