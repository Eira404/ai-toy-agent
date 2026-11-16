/**
 * `toy-memory-read` 的插件配置与重试参数。
 *
 * read 是检索编排层：负责生成 Query Embedding、并行调用 Fast 与 Long、
 * 汇总整体降级状态。它不生成记忆内容，也不做召回记录。
 */

/** 宿主装配 `MemoryRead` 时传入的配置。 */
export interface ReadConfig {
  /** Embedding 路由名，例如 `dashscope`；生成 Query 向量必需。 */
  readonly embeddingProvider: string
  /** Embedding 模型名，例如 `text-embedding-v3`。 */
  readonly embeddingModel: string

  /** 每个分支（Embedding / Fast / Long）的最大尝试次数（含首次），默认 2。 */
  readonly maxAttempts?: number
  /** 整次检索的截止时间毫秒，超时后不再重试，默认 5000。 */
  readonly deadlineMs?: number

  /** 时间源注入（毫秒时间戳），测试可用固定时钟；默认取系统当前时间。 */
  readonly now?: () => number
}

/** 填充默认值后的内部配置，service 只读取这一份。 */
export interface ResolvedReadConfig {
  readonly embeddingProvider: string
  readonly embeddingModel: string
  readonly maxAttempts: number
  readonly deadlineMs: number
  readonly now: () => number
}

const DEFAULTS = {
  maxAttempts: 2,
  deadlineMs: 5_000,
} as const

/** 合并默认值并校验关键字段，供 `MemoryRead` 构造函数调用。 */
export function resolveReadConfig(config: ReadConfig): ResolvedReadConfig {
  if (typeof config.embeddingProvider !== "string" || config.embeddingProvider.trim().length === 0) {
    throw new Error("embeddingProvider 必须是非空字符串")
  }
  if (typeof config.embeddingModel !== "string" || config.embeddingModel.trim().length === 0) {
    throw new Error("embeddingModel 必须是非空字符串")
  }
  if (config.maxAttempts !== undefined && (!Number.isSafeInteger(config.maxAttempts) || config.maxAttempts < 1)) {
    throw new Error("maxAttempts 必须是正安全整数")
  }
  if (config.deadlineMs !== undefined && (!Number.isSafeInteger(config.deadlineMs) || config.deadlineMs < 1)) {
    throw new Error("deadlineMs 必须是正安全整数")
  }
  return {
    embeddingProvider: config.embeddingProvider,
    embeddingModel: config.embeddingModel,
    maxAttempts: config.maxAttempts ?? DEFAULTS.maxAttempts,
    deadlineMs: config.deadlineMs ?? DEFAULTS.deadlineMs,
    now: config.now ?? (() => Date.now()),
  }
}
