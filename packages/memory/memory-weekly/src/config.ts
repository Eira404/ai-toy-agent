/** 宿主装配 `MemoryWeekly` 时传入的配置。 */
export interface WeeklyConfig {
  /** 关系型存储实例名称，默认 `main`。 */
  readonly relationalSource?: string
  /** LLM 路由名。 */
  readonly llmProvider: string
  /** LLM 模型名。 */
  readonly llmModel: string
  /** JEV 路由名；省略或空串时禁用 JEV（结构判断降级）。 */
  readonly jevProvider?: string
  /** Embedding 路由名。 */
  readonly embeddingProvider: string
  /** Embedding 模型名。 */
  readonly embeddingModel: string
  /** 单次调用阶段内重试上限（含首次），默认 3。 */
  readonly weeklyStageMaxAttempts?: number
  /** 提交事务重试上限，默认 3。 */
  readonly weeklyCommitMaxAttempts?: number
  /** 防饥饿阈值 N：上次成功 Weekly 后成功 Daily 次数达到 N 即不能跳过，默认 3。 */
  readonly antiStarvationN?: number
  /** 时间源注入，测试可用固定时钟；默认取系统当前时间。 */
  readonly now?: () => string
}

/** 填充默认值并校验后的内部配置。 */
export interface ResolvedWeeklyConfig {
  readonly relationalSource: string
  readonly llmProvider: string
  readonly llmModel: string
  readonly jevProvider: string
  readonly embeddingProvider: string
  readonly embeddingModel: string
  readonly weeklyStageMaxAttempts: number
  readonly weeklyCommitMaxAttempts: number
  readonly antiStarvationN: number
  readonly now: () => string
}

const DEFAULTS = {
  relationalSource: "main",
  weeklyStageMaxAttempts: 3,
  weeklyCommitMaxAttempts: 3,
  antiStarvationN: 3,
} as const

/** 合并默认值并校验关键字段，供 `MemoryWeekly` 构造函数调用。 */
export function resolveWeeklyConfig(config: WeeklyConfig): ResolvedWeeklyConfig {
  nonEmpty(config.llmProvider, "llmProvider")
  nonEmpty(config.llmModel, "llmModel")
  nonEmpty(config.embeddingProvider, "embeddingProvider")
  nonEmpty(config.embeddingModel, "embeddingModel")
  return {
    relationalSource: config.relationalSource ?? DEFAULTS.relationalSource,
    llmProvider: config.llmProvider,
    llmModel: config.llmModel,
    jevProvider: config.jevProvider ?? "",
    embeddingProvider: config.embeddingProvider,
    embeddingModel: config.embeddingModel,
    weeklyStageMaxAttempts: config.weeklyStageMaxAttempts ?? DEFAULTS.weeklyStageMaxAttempts,
    weeklyCommitMaxAttempts: config.weeklyCommitMaxAttempts ?? DEFAULTS.weeklyCommitMaxAttempts,
    antiStarvationN: config.antiStarvationN ?? DEFAULTS.antiStarvationN,
    now: config.now ?? (() => new Date().toISOString()),
  }
}

function nonEmpty(value: string, name: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${name} 必须是非空字符串`)
  }
}
