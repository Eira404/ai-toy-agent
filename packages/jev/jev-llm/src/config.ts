import { JevError } from "toy-jev"

/** JEV → LLM 桥接配置。模型不在此处，由调用时的 `JevRequest.model` 提供。 */
export interface JevLlmConfig {
  /** 注册到 `ctx.jev` 的 JEV 路由名，默认 `"llm"`。 */
  readonly provider?: string
  /** LLM 路由名：可以是单个 adapter，也可以是一条 LLM 降级链。 */
  readonly llmProvider: string
  /** 采样温度，默认 0。 */
  readonly temperature?: number
  /** 最大输出 Token，默认 1024。 */
  readonly maxTokens?: number
}

/** 已校验并复制的桥接配置。 */
export interface ResolvedJevLlmConfig {
  readonly provider: string
  readonly llmProvider: string
  readonly temperature: number
  readonly maxTokens: number
}

/** 校验桥接配置。 */
export function resolveConfig(config: JevLlmConfig): ResolvedJevLlmConfig {
  const provider = config.provider?.trim() || "llm"
  const llmProvider = config.llmProvider.trim()
  if (llmProvider.length === 0) {
    throw new JevError("JEV LLM 桥接需要非空的 llmProvider", "INVALID_REQUEST")
  }
  const temperature = config.temperature ?? 0
  if (!Number.isFinite(temperature) || temperature < 0) {
    throw new JevError("temperature 必须是非负有限数字", "INVALID_REQUEST")
  }
  const maxTokens = config.maxTokens ?? 1024
  if (!Number.isSafeInteger(maxTokens) || maxTokens <= 0) {
    throw new JevError("maxTokens 必须是正整数", "INVALID_REQUEST")
  }
  return {
    provider,
    llmProvider,
    temperature,
    maxTokens,
  }
}
