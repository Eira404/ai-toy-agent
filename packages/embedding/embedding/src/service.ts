import { Service, type Context } from "cordis"
import type { EmbeddingAdapter } from "./adapter.js"
import { EmbeddingError } from "./error.js"
import type {
  EmbeddingChainOptions,
  EmbeddingFailure,
  EmbeddingFallbackPredicate,
  EmbeddingProviderInfo,
  EmbeddingRequest,
  EmbeddingResult,
  EmbeddingRouteEntry,
} from "./types.js"

declare module "cordis" {
  interface Context {
    embedding: EmbeddingRuntime
  }
}

/** 已注册的嵌入路由及其展示信息快照。 */
interface Registration {
  readonly adapter: EmbeddingAdapter
  readonly info: EmbeddingProviderInfo
}

/** 已注册的降级链：有序候选列表，第一个是默认。 */
interface EmbeddingChain {
  readonly name: string
  readonly entries: readonly EmbeddingRouteEntry[]
  readonly retryable: EmbeddingFallbackPredicate
  readonly onFallback?: EmbeddingChainOptions["onFallback"]
}

/** provider 名称解析结果：单适配器或降级链。 */
type EmbeddingRoute =
  | { readonly kind: "adapter"; readonly registration: Registration }
  | { readonly kind: "chain"; readonly chain: EmbeddingChain }

/** 默认可降级失败：适配器标记为 retryable 且非取消的错误。 */
function isRetryableFailure(error: unknown): boolean {
  if (error instanceof EmbeddingError) {
    return error.retryable && error.code !== "ABORTED"
  }
  return true
}

/** 挂载到 `ctx.embedding` 的嵌入服务。适配器按名称注册，降级链按候选顺序自动降级。 */
export class EmbeddingRuntime extends Service {
  private readonly adapters = new Map<string, Registration>()
  private readonly chains = new Map<string, EmbeddingChain>()

  constructor(ctx: Context) {
    super(ctx, "embedding")
  }

  /**
   * 注册一个可用于 `embed` 的嵌入路由。
   *
   * @param provider 请求使用的路由名，例如 "dashscope"。
   * @param adapter 将批量文本转换为 Provider 请求并返回向量的适配器。
   * @returns 幂等注销函数。插件可以用 `ctx.effect` 在卸载时自动调用。
   */
  registerAdapter(provider: string, adapter: EmbeddingAdapter): () => void {
    const id = provider.trim()
    if (id.length === 0) {
      throw new EmbeddingError("Provider 名称不能为空", "INVALID_REQUEST")
    }
    if (this.adapters.has(id) || this.chains.has(id)) {
      throw new EmbeddingError(`Provider '${id}' 已注册`, "DUPLICATE_ADAPTER")
    }
    const info = structuredClone(adapter.providerInfo(id))
    if (info.id !== id) {
      throw new EmbeddingError("Provider 信息中的 id 必须与注册名称一致", "INVALID_REQUEST")
    }
    const registration = { adapter, info }
    this.adapters.set(id, registration)
    return () => {
      if (this.adapters.get(id) === registration) {
        this.adapters.delete(id)
      }
    }
  }

  /**
   * 注册一个嵌入降级链：按顺序尝试各候选，前一个可降级失败则尝试下一个。
   *
   * @param name 逻辑路由名。调用时用它作为 `request.provider`。
   * @param entries 有序候选列表，第一个是默认。每个候选的 provider 必须已注册。
   * @param options 可选的重试判定与降级回调。
   * @returns 幂等注销函数。
   */
  registerChain(
    name: string,
    entries: readonly EmbeddingRouteEntry[],
    options: EmbeddingChainOptions = {},
  ): () => void {
    const id = name.trim()
    if (id.length === 0) {
      throw new EmbeddingError("Embedding 降级链名称不能为空", "INVALID_REQUEST")
    }
    if (this.adapters.has(id) || this.chains.has(id)) {
      throw new EmbeddingError(`Provider '${id}' 已注册`, "DUPLICATE_ADAPTER")
    }
    const normalized: EmbeddingRouteEntry[] = entries.map((entry) => ({
      provider: entry.provider.trim(),
      model: entry.model.trim(),
    }))
    if (normalized.length === 0) {
      throw new EmbeddingError("Embedding 降级链至少需要一个候选", "INVALID_REQUEST")
    }
    for (const entry of normalized) {
      if (entry.provider.length === 0 || entry.model.length === 0) {
        throw new EmbeddingError("Embedding 降级链候选的 provider 和 model 不能为空", "INVALID_REQUEST")
      }
      if (!this.adapters.has(entry.provider)) {
        throw new EmbeddingError(
          `Embedding 降级链候选 Provider '${entry.provider}' 没有注册 Adapter`,
          "NO_ADAPTER",
        )
      }
    }
    const chain: EmbeddingChain = {
      name: id,
      entries: normalized,
      retryable: options.retryable ?? isRetryableFailure,
      onFallback: options.onFallback,
    }
    this.chains.set(id, chain)
    return () => {
      if (this.chains.get(id) === chain) {
        this.chains.delete(id)
      }
    }
  }

  /** @returns 按注册顺序排列的路由信息快照（单适配器在前，降级链在后）。 */
  listProviders(): readonly EmbeddingProviderInfo[] {
    const adapters = [...this.adapters.values()].map(({ info }) => structuredClone(info))
    const chains = [...this.chains.values()].map((chain) => ({ id: chain.name, name: chain.name }))
    return [...adapters, ...chains]
  }

  /**
   * @param provider 要查询的已注册路由或降级链。
   * @returns 路由信息快照。
   */
  providerInfo(provider: string): EmbeddingProviderInfo {
    const route = this.resolveRoute(provider)
    return route.kind === "adapter"
      ? structuredClone(route.registration.info)
      : { id: route.chain.name, name: route.chain.name }
  }

  /**
   * 执行一次批量嵌入。
   *
   * @param request 指定 provider、model、待嵌入文本，可选 operation 和取消信号。provider 命中降级链时按序降级。
   * @returns 与文本顺序一致的向量、Provider 返回的模型名和维度。
   * @throws {EmbeddingError} 输入非法、路由不存在、取消或结果与文本数量不一致时抛出。
   */
  async embed(request: EmbeddingRequest): Promise<EmbeddingResult> {
    this.assertValidRequest(request)
    const route = this.resolveRoute(request.provider)
    if (route.kind === "adapter") {
      return this.embedAdapter(request, route.registration)
    }
    return this.embedChain(request, route.chain)
  }

  private async embedAdapter(
    request: EmbeddingRequest,
    registration: Registration,
  ): Promise<EmbeddingResult> {
    const { signal } = request
    try {
      signal?.throwIfAborted()
      const result = await registration.adapter.embed(request)
      signal?.throwIfAborted()
      this.assertValidResult(request.texts.length, result)
      return result
    } catch (error) {
      if (signal?.aborted && !(error instanceof EmbeddingError && error.code === "ABORTED")) {
        throw new EmbeddingError("嵌入请求已取消", "ABORTED", { cause: signal.reason })
      }
      throw error
    }
  }

  private async embedChain(
    request: EmbeddingRequest,
    chain: EmbeddingChain,
  ): Promise<EmbeddingResult> {
    const failures: EmbeddingFailure[] = []
    for (let index = 0; index < chain.entries.length; index += 1) {
      const entry = chain.entries[index]!
      const registration = this.requireProvider(entry.provider)
      const attempt = this.attemptRequest(request, entry)
      try {
        return await this.embedAdapter(attempt, registration)
      } catch (error) {
        if (chain.retryable(error)) {
          const failure = this.failureOf(entry, error)
          failures.push(failure)
          this.recordFallback(chain, index, entry, failure)
          continue
        }
        throw error
      }
    }
    throw new EmbeddingError(`Embedding 降级链 '${chain.name}' 的所有候选均失败`, "FALLBACK_EXHAUSTED", {
      attempts: failures,
    })
  }

  private resolveRoute(provider: string): EmbeddingRoute {
    const id = provider.trim()
    const adapter = this.adapters.get(id)
    if (adapter !== undefined) {
      return { kind: "adapter", registration: adapter }
    }
    const chain = this.chains.get(id)
    if (chain !== undefined) {
      return { kind: "chain", chain }
    }
    throw new EmbeddingError(`Provider '${provider}' 没有注册 Adapter`, "NO_ADAPTER")
  }

  private requireProvider(provider: string): Registration {
    const registration = this.adapters.get(provider)
    if (registration === undefined) {
      throw new EmbeddingError(`Provider '${provider}' 没有注册 Adapter`, "NO_ADAPTER")
    }
    return registration
  }

  private attemptRequest(request: EmbeddingRequest, entry: EmbeddingRouteEntry): EmbeddingRequest {
    return {
      ...request,
      provider: entry.provider,
      model: entry.model,
    }
  }

  private failureOf(entry: EmbeddingRouteEntry, error: unknown): EmbeddingFailure {
    if (error instanceof EmbeddingError) {
      return {
        provider: entry.provider,
        model: entry.model,
        code: error.code,
        message: error.message,
      }
    }
    return {
      provider: entry.provider,
      model: entry.model,
      code: "UNKNOWN",
      message: error instanceof Error ? error.message : String(error),
    }
  }

  private recordFallback(
    chain: EmbeddingChain,
    index: number,
    entry: EmbeddingRouteEntry,
    failure: EmbeddingFailure,
  ): void {
    chain.onFallback?.(index, entry, failure)
    this.ctx.logger("embedding").warn(
      "Embedding 降级链 %s 候选 %s/%s 失败（%s），尝试下一个",
      chain.name,
      entry.provider,
      entry.model,
      failure.code,
    )
  }

  private assertValidRequest(request: EmbeddingRequest): void {
    if (request.texts.length === 0) {
      throw new EmbeddingError("texts 不能为空", "INVALID_REQUEST")
    }
    if (request.model.trim().length === 0) {
      throw new EmbeddingError("model 不能为空", "INVALID_REQUEST")
    }
  }

  private assertValidResult(expectedCount: number, result: EmbeddingResult): void {
    if (result.vectors.length !== expectedCount) {
      throw new EmbeddingError("嵌入结果数量与输入文本数量不一致", "INVALID_RESPONSE")
    }
    if (!Number.isSafeInteger(result.dimensions) || result.dimensions < 1) {
      throw new EmbeddingError("嵌入维度必须是正整数", "INVALID_RESPONSE")
    }
  }
}

export default EmbeddingRuntime
