/**
 * `toy-memory-space` 的插件配置。
 *
 * 本包只管理记忆空间元数据（空间 + 娃娃绑定），不生成记忆内容、不接 Session。
 * 空间名长度硬限制属于产品级统一配置，由宿主装配时提供。
 */

/** 宿主装配 `MemorySpaceService` 时传入的配置。 */
export interface SpaceConfig {
  /** 关系型存储实例名称，默认 `main`。 */
  readonly relationalSource?: string
  /** 空间名硬限制字符数，默认 64；空串归一化为 null。 */
  readonly maxNameLength?: number

  /** 时间源注入（ISO 8601 字符串），测试可用固定时钟；默认取系统当前时间。 */
  readonly now?: () => string
}

/** 填充默认值后的内部配置，service 只读取这一份。 */
export interface ResolvedSpaceConfig {
  readonly relationalSource: string
  readonly maxNameLength: number
  readonly now: () => string
}

const DEFAULTS = {
  relationalSource: "main",
  maxNameLength: 64,
} as const

/** 合并默认值并校验关键字段，供 `MemorySpaceService` 构造函数调用。 */
export function resolveSpaceConfig(config: SpaceConfig = {}): ResolvedSpaceConfig {
  if (
    config.maxNameLength !== undefined &&
    (!Number.isSafeInteger(config.maxNameLength) || config.maxNameLength < 1)
  ) {
    throw new Error("maxNameLength 必须是正安全整数")
  }
  return {
    relationalSource: config.relationalSource ?? DEFAULTS.relationalSource,
    maxNameLength: config.maxNameLength ?? DEFAULTS.maxNameLength,
    now: config.now ?? (() => new Date().toISOString()),
  }
}
