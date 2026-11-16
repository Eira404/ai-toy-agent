/** 一次批量嵌入请求，由核心层在路由解析后原样交给适配器。 */
export interface EmbeddingRequest {
  /** 调用方选择的路由名，例如 "dashscope"。 */
  readonly provider: string
  /** 本次调用使用的模型名，例如 "text-embedding-v3"。 */
  readonly model: string
  /** 待嵌入的文本，至少一条。 */
  readonly texts: readonly string[]
  /** 调用方传入的操作标识，便于日志、监控和重试分组；可省略。 */
  readonly operation?: string
  /** 取消信号，适配器应尽快终止尚未完成的工作。 */
  readonly signal?: AbortSignal
}

/** 一次批量嵌入的结果。 */
export interface EmbeddingResult {
  /** 与请求 texts 顺序一一对应的向量。 */
  readonly vectors: readonly (readonly number[])[]
  /** Provider 实际返回的模型标识。 */
  readonly modelId: string
  /** 每个向量的维度，调用方可据此校验与存储 Schema 的一致性。 */
  readonly dimensions: number
}

/** 嵌入 Provider 路由注册后对外展示的信息。 */
export interface EmbeddingProviderInfo {
  readonly id: string
  readonly name: string
}

/** 降级链中的一个候选路由条目。 */
export interface EmbeddingRouteEntry {
  /** 已注册的 adapter 路由名。 */
  readonly provider: string
  /** 该候选实际使用的模型名。 */
  readonly model: string
}

/** 降级链中某个候选的失败摘要。 */
export interface EmbeddingFailure {
  readonly provider: string
  readonly model: string
  readonly code: string
  readonly message: string
}

/** 判定某次失败是否应继续降级到下一个候选；返回 true 表示继续尝试。 */
export type EmbeddingFallbackPredicate = (error: unknown) => boolean

/** 降级链的可选行为配置。 */
export interface EmbeddingChainOptions {
  /** 覆盖默认的「可降级失败」判定。默认对标记为 retryable 的失败降级。 */
  readonly retryable?: EmbeddingFallbackPredicate
  /**
   * 每次切换候选时回调，用于观测与告警。
   * `attempt` 为失败候选的 0-based 索引，`entry` 为该候选，`failure` 为其失败摘要。
   */
  readonly onFallback?: (
    attempt: number,
    entry: EmbeddingRouteEntry,
    failure: EmbeddingFailure,
  ) => void
}
