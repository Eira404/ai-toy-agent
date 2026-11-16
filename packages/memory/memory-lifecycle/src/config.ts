import type { JevSupportConfig } from "toy-model-support"

/**
 * `MemoryOnline` 的装配配置。
 *
 * `provider` 是 JEV 路由名（由宿主在装配 `toy-jev` 时注册）；省略时若只注册了
 * 一个 JEV Adapter，`JevRuntime` 会自动选择它。
 */
export type MemoryOnlineConfig = JevSupportConfig
