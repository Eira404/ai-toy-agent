/**
 * `toy-memory-scheduler` 的插件配置。
 *
 * 本包只负责「到点触发」：扫描到期调度、判断阈值、调 `runDaily`，不生成记忆内容。
 */

/** 宿主装配 `MemoryScheduler` 时传入的配置。 */
export interface SchedulerConfig {
  /** 关系型存储实例名称，默认 `main`。 */
  readonly relationalSource?: string
  /** 扫描到期调度的周期毫秒数，默认 60000（1 分钟）。 */
  readonly scheduleTickMs?: number
  /** 单轮扫描内并发运行 Daily 的上限，默认 3。 */
  readonly maxConcurrentRuns?: number

  /** 时间源注入（ISO 8601 字符串），测试可用固定时钟；默认取系统当前时间。 */
  readonly now?: () => string
}

/** 填充默认值后的内部配置，service 只读取这一份。 */
export interface ResolvedSchedulerConfig {
  readonly relationalSource: string
  readonly scheduleTickMs: number
  readonly maxConcurrentRuns: number
  readonly now: () => string
}

const DEFAULTS = {
  relationalSource: "main",
  scheduleTickMs: 60_000,
  maxConcurrentRuns: 3,
} as const

/** 合并默认值并校验关键字段，供 `MemoryScheduler` 构造函数调用。 */
export function resolveSchedulerConfig(config: SchedulerConfig = {}): ResolvedSchedulerConfig {
  if (
    config.scheduleTickMs !== undefined &&
    (!Number.isSafeInteger(config.scheduleTickMs) || config.scheduleTickMs < 1)
  ) {
    throw new Error("scheduleTickMs 必须是正安全整数")
  }
  if (
    config.maxConcurrentRuns !== undefined &&
    (!Number.isSafeInteger(config.maxConcurrentRuns) || config.maxConcurrentRuns < 1)
  ) {
    throw new Error("maxConcurrentRuns 必须是正安全整数")
  }
  return {
    relationalSource: config.relationalSource ?? DEFAULTS.relationalSource,
    scheduleTickMs: config.scheduleTickMs ?? DEFAULTS.scheduleTickMs,
    maxConcurrentRuns: config.maxConcurrentRuns ?? DEFAULTS.maxConcurrentRuns,
    now: config.now ?? (() => new Date().toISOString()),
  }
}
