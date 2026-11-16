/**
 * `toy-memory-daily` 的插件配置：存储路由、模型路由与整体重试上限。
 *
 * 模型路由命名与 `toy-memory-fast` 保持一致（`xxxProvider` / `xxxModel`）。
 */

/** 宿主装配 `MemoryDaily` 时传入的配置。 */
export interface DailyConfig {
  /** 关系型存储实例名称，默认 `main`。 */
  readonly relationalSource?: string
  /** LLM 路由名，例如 `dashscope`。 */
  readonly llmProvider: string
  /** LLM 模型名，例如 `qwen-max`。 */
  readonly llmModel: string
  /** JEV 路由名，例如 `typesafe`；省略或空串时禁用 JEV（Domain 降级 self、相关块跳过 JEV 筛选）。 */
  readonly jevProvider?: string
  /** Embedding 路由名，例如 `dashscope`。 */
  readonly embeddingProvider: string
  /** Embedding 模型名，例如 `text-embedding-v3`。 */
  readonly embeddingModel: string
  /** 整体失败重试上限（含首次），默认 3。 */
  readonly maxAttempts?: number
  /** 阶段内独立 item 的并行度（任务池并发上限），默认 4。 */
  readonly mapConcurrency?: number
  /** 时间源注入，测试可用固定时钟；默认取系统当前时间。 */
  readonly now?: () => string
}

/** 填充默认值并校验后的内部配置。 */
export interface ResolvedDailyConfig {
  readonly relationalSource: string
  readonly llmProvider: string
  readonly llmModel: string
  readonly jevProvider: string
  readonly embeddingProvider: string
  readonly embeddingModel: string
  readonly maxAttempts: number
  readonly mapConcurrency: number
  readonly now: () => string
}

const DEFAULTS = {
  relationalSource: "main",
  maxAttempts: 3,
  mapConcurrency: 4,
} as const

/** 合并默认值并校验关键字段，供 `MemoryDaily` 构造函数调用。 */
export function resolveDailyConfig(config: DailyConfig): ResolvedDailyConfig {
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
    maxAttempts: config.maxAttempts ?? DEFAULTS.maxAttempts,
    mapConcurrency: config.mapConcurrency ?? DEFAULTS.mapConcurrency,
    now: config.now ?? (() => new Date().toISOString()),
  }
}

function nonEmpty(value: string, name: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${name} 必须是非空字符串`)
  }
}
