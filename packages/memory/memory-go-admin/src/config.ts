/**
 * `toy-memory-go-admin` 的插件配置。
 *
 * 本包通过 `toy-admin` 注册只读运维能力，同时为「临时用户读取」直接访问关系表，
 * 因此需要关系型存储实例名。
 */

/** 宿主装配 `MemoryGoAdmin` 时传入的配置。 */
export interface MemoryGoAdminConfig {
  /** 关系型存储实例名称，默认 `main`。 */
  readonly relationalSource?: string
}

/** 填充默认值后的内部配置，service 只读取这一份。 */
export interface ResolvedMemoryGoAdminConfig {
  readonly relationalSource: string
}

/** 合并默认值，供 `MemoryGoAdmin` 构造函数调用。 */
export function resolveMemoryGoAdminConfig(
  config: MemoryGoAdminConfig = {},
): ResolvedMemoryGoAdminConfig {
  return {
    relationalSource: config.relationalSource ?? "main",
  }
}
