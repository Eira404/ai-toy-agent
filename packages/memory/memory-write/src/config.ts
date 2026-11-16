/** `toy-memory-write` 的插件配置；`llmProvider` 与 `llmModel` 必填。 */
export interface FastExtractConfig {
  readonly llmProvider: string
  readonly llmModel: string
  /** LLM 提取最大尝试次数（含首次），默认 2，即失败重试 1 次。 */
  readonly maxAttempts?: number
  /** 注入 prompt 的近期对话条数，默认 20。 */
  readonly recentConversationLimit?: number
  /** 注入 prompt 的同 Session 最近 Fast 条数，默认 30。 */
  readonly recentSessionFastLimit?: number
  /** 单轮提取输出条数上限，默认 10。 */
  readonly maxMemoriesPerTurn?: number
  /** 提取调用最大输出 token，可选。 */
  readonly maxTokens?: number
}

/** 填充默认值并完成校验后的内部配置。 */
export interface ResolvedFastExtractConfig {
  readonly llmProvider: string
  readonly llmModel: string
  readonly maxAttempts: number
  readonly recentConversationLimit: number
  readonly recentSessionFastLimit: number
  readonly maxMemoriesPerTurn: number
  readonly maxTokens: number | undefined
}

const DEFAULTS = {
  maxAttempts: 2,
  recentConversationLimit: 20,
  recentSessionFastLimit: 30,
  maxMemoriesPerTurn: 10,
} as const

/** 合并默认值并校验关键字段。 */
export function resolveFastExtractConfig(config: FastExtractConfig): ResolvedFastExtractConfig {
  if (typeof config.llmProvider !== "string" || config.llmProvider.trim().length === 0) {
    throw new Error("llmProvider 必须是非空字符串")
  }
  if (typeof config.llmModel !== "string" || config.llmModel.trim().length === 0) {
    throw new Error("llmModel 必须是非空字符串")
  }
  return {
    llmProvider: config.llmProvider,
    llmModel: config.llmModel,
    maxAttempts: config.maxAttempts ?? DEFAULTS.maxAttempts,
    recentConversationLimit: config.recentConversationLimit ?? DEFAULTS.recentConversationLimit,
    recentSessionFastLimit: config.recentSessionFastLimit ?? DEFAULTS.recentSessionFastLimit,
    maxMemoriesPerTurn: config.maxMemoriesPerTurn ?? DEFAULTS.maxMemoriesPerTurn,
    maxTokens: config.maxTokens,
  }
}
