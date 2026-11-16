/**
 * `toy-memory-go-backend` 的插件配置。
 *
 * 仅承载「新建空间时自动挂 daily 调度」的参数；其余行为固定，不做开放。
 *
 * `dailyAt` 缺省时不返回固定钟点，而是由 service 在「每个新建空间」上随机取
 * 02:00–02:59 内的一个分钟，避免大量空间在同一时刻触发 Daily 造成挤压。
 */

/** 宿主装配 `MemoryGoBackend` 时传入的配置。 */
export interface GoBackendConfig {
  /** 每天触发钟点，24 小时制 "HH:mm"；缺省时每个新建空间随机取 02:00–02:59。 */
  readonly dailyAt?: string
  /** 触发钟点所在 IANA 时区，默认 "Asia/Shanghai"。 */
  readonly timeZone?: string
  /** 待整合 Fast 阈值（未达阈值当天不跑 Daily），默认 10。 */
  readonly minPendingFast?: number
}

/** 填充默认值后的内部配置，service 只读取这一份。`dailyAt` 为 undefined 表示随机。 */
export interface ResolvedGoBackendConfig {
  readonly dailyAt: string | undefined
  readonly timeZone: string
  readonly minPendingFast: number
}

const DEFAULTS = {
  timeZone: "Asia/Shanghai",
  minPendingFast: 10,
} as const

/** 默认随机触发窗口的小时：02:00–02:59。 */
const RANDOM_HOUR = 2

/** 合并默认值并校验关键字段。 */
export function resolveGoBackendConfig(config: GoBackendConfig = {}): ResolvedGoBackendConfig {
  if (config.dailyAt !== undefined && !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(config.dailyAt)) {
    throw new Error("dailyAt 必须是 HH:mm（24 小时制）")
  }
  if (config.timeZone !== undefined && config.timeZone.trim().length === 0) {
    throw new Error("timeZone 必须是非空字符串")
  }
  if (
    config.minPendingFast !== undefined &&
    (!Number.isSafeInteger(config.minPendingFast) || config.minPendingFast < 0)
  ) {
    throw new Error("minPendingFast 必须是非负安全整数")
  }
  return {
    dailyAt: config.dailyAt,
    timeZone: config.timeZone ?? DEFAULTS.timeZone,
    minPendingFast: config.minPendingFast ?? DEFAULTS.minPendingFast,
  }
}

/** 在 02:00–02:59 内随机取一个分钟，返回 "HH:mm"。 */
export function randomDailyAt(): string {
  const minute = Math.floor(Math.random() * 60)
  return `${String(RANDOM_HOUR).padStart(2, "0")}:${String(minute).padStart(2, "0")}`
}
