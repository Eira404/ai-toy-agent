/**
 * toy-memory-value 公共入口。
 * 常规宿主挂载 MemoryValue；独立装配使用 ValueEngine；
 * ForgettingEngine 与状态编解码供数值验证/调试使用，不会自动注册插件。
 */
export { MemoryValue, MemoryValue as default } from "./service.js"
export { ValueEngine } from "./engine.js"
export { ForgettingEngine } from "./forgetting.js"
export { ValueEngineError } from "./error.js"
export type { ValueEngineErrorCode } from "./error.js"
export {
  DEFAULT_FORGETTING_CONFIG,
  ForgettingConfigSchema,
  resolveMemoryValueConfig,
} from "./config.js"
export type { ForgettingConfig, MemoryValueConfig, ResolvedMemoryValueConfig } from "./config.js"
export { VALUE_VERSION, ValueDataSchema, decodeValueState, encodeValueState } from "./state.js"
export type { ValueData } from "./state.js"
export { JUDGEMENT_VERSION } from "./judges/feedback.js"
export type { ImportanceLevel, ContentChange } from "./schema.js"
