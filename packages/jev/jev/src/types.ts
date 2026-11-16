import type { JevQuestions, JevResponse } from "./schema.js"

/** 传递给 Adapter 的完整请求。`model` 必填：由链条目或 invoke options 提供，adapter 不持有模型。 */
export interface JevRequest {
  readonly provider: string
  readonly model: string
  readonly state: string
  readonly questions: JevQuestions
  readonly signal?: AbortSignal
}

/** `ctx.jev.invoke()` 的可选控制参数。 */
export interface JevInvokeOptions {
  /** 未指定时，只有一个 Adapter 的注册表会自动选择该 Adapter。 */
  readonly provider?: string
  /** provider 是单 adapter 时必填；是降级链时由链条目决定。 */
  readonly model?: string
  readonly signal?: AbortSignal
}

/** 不依赖 Cordis 的最小 JEV 调用接口，便于业务包注入测试替身。 */
export interface Jev {
  invoke(state: string, questions: JevQuestions, options?: JevInvokeOptions): Promise<JevResponse>
}

/** 降级链中的一个候选路由条目。`model` 必填，与 LLM 的链条目一致。 */
export interface JevRouteEntry {
  readonly provider: string
  readonly model: string
}

/** 降级链中某个候选的失败摘要。 */
export interface JevFailure {
  readonly provider: string
  readonly code: string
  readonly message: string
}

/** 判定某次失败是否应继续降级到下一个候选；返回 true 表示继续尝试。 */
export type JevFallbackPredicate = (error: unknown) => boolean

/** 降级链的可选行为配置。 */
export interface JevChainOptions {
  /** 覆盖默认的「可降级失败」判定。默认对标记为 retryable 的失败降级。 */
  readonly retryable?: JevFallbackPredicate
  /**
   * 每次切换候选时回调，用于观测与告警。
   * `attempt` 为失败候选的 0-based 索引，`provider` 为该候选，`failure` 为其失败摘要。
   */
  readonly onFallback?: (attempt: number, provider: string, failure: JevFailure) => void
}
