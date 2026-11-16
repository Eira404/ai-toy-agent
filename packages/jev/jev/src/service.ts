import { Service, type Context } from "cordis"
import { z } from "zod"
import type { JevAdapter, JevProviderInfo } from "./adapter.js"
import { JevError } from "./error.js"
import { JevQuestionsSchema, type JevQuestions, type JevResponse } from "./schema.js"
import type {
  Jev,
  JevChainOptions,
  JevFailure,
  JevFallbackPredicate,
  JevInvokeOptions,
  JevRouteEntry,
} from "./types.js"
import { validateAnswers } from "./validation.js"

declare module "cordis" {
  interface Context {
    jev: JevRuntime
  }
}

/** 一条命名路由及对外展示的信息。 */
interface Registration {
  readonly adapter: JevAdapter
  readonly info: JevProviderInfo
}

/** 已注册的降级链：有序候选列表，第一个是默认。 */
interface JevChain {
  readonly name: string
  readonly entries: readonly JevRouteEntry[]
  readonly retryable: JevFallbackPredicate
  readonly onFallback?: JevChainOptions["onFallback"]
}

/** provider 名称解析结果：单适配器或降级链。 */
type JevRoute =
  | { readonly kind: "adapter"; readonly registration: Registration }
  | { readonly kind: "chain"; readonly chain: JevChain }

/** 默认可降级失败：适配器标记为 retryable 且非取消的错误。 */
function isRetryableFailure(error: unknown): boolean {
  if (error instanceof JevError) {
    return error.retryable && error.code !== "ABORTED"
  }
  return true
}

/** 挂载到 `ctx.jev` 的结构化评估服务。负责校验、选择适配器、降级和匹配答案。 */
export class JevRuntime extends Service implements Jev {
  private readonly adapters = new Map<string, Registration>()
  private readonly chains = new Map<string, JevChain>()

  constructor(ctx: Context) {
    super(ctx, "jev")
  }

  /**
   * 注册一个 JEV 适配器。
   *
   * @param provider 调用方选择路由时使用的名称。
   * @param adapter 执行具体请求的适配器。
   * @returns 幂等注销函数，可绑定到 Cordis 插件的卸载周期。
   */
  registerAdapter(provider: string, adapter: JevAdapter): () => void {
    const id = provider.trim()
    if (id.length === 0) {
      throw new JevError("Provider 名称不能为空", "INVALID_REQUEST")
    }
    if (this.adapters.has(id) || this.chains.has(id)) {
      throw new JevError(`Provider '${id}' 已注册`, "DUPLICATE_ADAPTER")
    }
    const info = { ...adapter.providerInfo(id) }
    if (info.id !== id) {
      throw new JevError("Provider 信息中的 id 必须与注册名称一致", "INVALID_REQUEST")
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
   * 注册一个 JEV 降级链：按顺序尝试各候选，前一个可降级失败则尝试下一个。
   *
   * 每个候选是 `{ provider, model? }`：`provider` 必须是已注册的 adapter 名，
   * `model` 覆盖该 adapter 的默认模型（便于同一 adapter 以不同模型降级，无需注册多个 adapter）。
   *
   * @param name 逻辑路由名。调用时用它作为 `options.provider`。
   * @param entries 有序候选列表，第一个是默认。
   * @param options 可选的重试判定与降级回调。
   * @returns 幂等注销函数。
   */
  registerChain(name: string, entries: readonly JevRouteEntry[], options: JevChainOptions = {}): () => void {
    const id = name.trim()
    if (id.length === 0) {
      throw new JevError("JEV 降级链名称不能为空", "INVALID_REQUEST")
    }
    if (this.adapters.has(id) || this.chains.has(id)) {
      throw new JevError(`Provider '${id}' 已注册`, "DUPLICATE_ADAPTER")
    }
    const normalized: JevRouteEntry[] = entries.map((entry) => ({
      provider: entry.provider.trim(),
      model: entry.model.trim(),
    }))
    if (normalized.length === 0) {
      throw new JevError("JEV 降级链至少需要一个候选", "INVALID_REQUEST")
    }
    for (const entry of normalized) {
      if (entry.provider.length === 0) {
        throw new JevError("JEV 降级链候选 provider 不能为空", "INVALID_REQUEST")
      }
      if (entry.model.length === 0) {
        throw new JevError("JEV 降级链候选 model 不能为空", "INVALID_REQUEST")
      }
      if (!this.adapters.has(entry.provider)) {
        throw new JevError(`JEV 降级链候选 Provider '${entry.provider}' 没有注册 Adapter`, "NO_ADAPTER")
      }
    }
    const chain: JevChain = {
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
  listProviders(): readonly JevProviderInfo[] {
    const adapters = [...this.adapters.values()].map(({ info }) => ({ ...info }))
    const chains = [...this.chains.values()].map((chain) => ({ id: chain.name, name: chain.name }))
    return [...adapters, ...chains]
  }

  /**
   * 执行一次结构化评估。
   *
   * @param state 供评估的非空文本。
   * @param questions 以问题名索引的问题定义。
   * @param options 可指定 provider 和取消信号。仅有一个已注册路由时可省略 provider。
   * @returns 已通过 Schema 校验并与问题匹配的答案。
   */
  async invoke(
    state: string,
    questions: JevQuestions,
    options: JevInvokeOptions = {},
  ): Promise<JevResponse> {
    if (typeof state !== "string" || state.trim().length === 0) {
      throw new JevError("JEV state 必须是非空文本", "INVALID_REQUEST")
    }
    const parsed = JevQuestionsSchema.safeParse(questions)
    if (!parsed.success) {
      throw new JevError(`JEV questions 无效：${z.prettifyError(parsed.error)}`, "INVALID_REQUEST")
    }

    const route = this.resolve(options.provider)
    const trimmed = state.trim()
    if (route.kind === "adapter") {
      const model = options.model?.trim()
      if (model === undefined || model.length === 0) {
        throw new JevError("单 adapter 调用需要指定 model", "INVALID_REQUEST")
      }
      return this.invokeAdapter(parsed.data, trimmed, route.registration, model, options.signal)
    }
    return this.invokeChain(parsed.data, trimmed, route.chain, options.signal)
  }

  private async invokeAdapter(
    questions: JevQuestions,
    state: string,
    registration: Registration,
    model: string,
    signal?: AbortSignal,
  ): Promise<JevResponse> {
    try {
      signal?.throwIfAborted()
      const response = await registration.adapter.invoke({
        provider: registration.info.id,
        model,
        state,
        questions,
        ...(signal === undefined ? {} : { signal }),
      })
      signal?.throwIfAborted()
      return validateAnswers(questions, response)
    } catch (error) {
      if (signal?.aborted && !(error instanceof JevError && error.code === "ABORTED")) {
        throw new JevError("JEV 请求已取消", "ABORTED", { cause: signal.reason })
      }
      throw error
    }
  }

  private async invokeChain(
    questions: JevQuestions,
    state: string,
    chain: JevChain,
    signal?: AbortSignal,
  ): Promise<JevResponse> {
    const failures: JevFailure[] = []
    for (let index = 0; index < chain.entries.length; index += 1) {
      const entry = chain.entries[index]!
      const registration = this.requireAdapter(entry.provider)
      try {
        return await this.invokeAdapter(questions, state, registration, entry.model, signal)
      } catch (error) {
        if (chain.retryable(error)) {
          const failure = this.failureOf(entry.provider, error)
          failures.push(failure)
          this.recordFallback(chain, index, entry.provider, failure)
          continue
        }
        throw error
      }
    }
    throw new JevError(`JEV 降级链 '${chain.name}' 的所有候选均失败`, "FALLBACK_EXHAUSTED", {
      attempts: failures,
    })
  }

  private resolve(provider: string | undefined): JevRoute {
    if (provider !== undefined) {
      return this.resolveRoute(provider)
    }
    if (this.adapters.size + this.chains.size === 1) {
      const adapter = [...this.adapters.values()][0]
      if (adapter !== undefined) {
        return { kind: "adapter", registration: adapter }
      }
      const chain = [...this.chains.values()][0]
      if (chain !== undefined) {
        return { kind: "chain", chain }
      }
    }
    throw new JevError(
      this.adapters.size + this.chains.size === 0
        ? "没有注册 JEV Adapter"
        : "存在多个 JEV 路由，请指定 provider",
      "NO_ADAPTER",
    )
  }

  private resolveRoute(provider: string): JevRoute {
    const id = provider.trim()
    const adapter = this.adapters.get(id)
    if (adapter !== undefined) {
      return { kind: "adapter", registration: adapter }
    }
    const chain = this.chains.get(id)
    if (chain !== undefined) {
      return { kind: "chain", chain }
    }
    throw new JevError(`Provider '${provider}' 没有注册 Adapter`, "NO_ADAPTER")
  }

  private requireAdapter(provider: string): Registration {
    const registration = this.adapters.get(provider)
    if (registration === undefined) {
      throw new JevError(`Provider '${provider}' 没有注册 Adapter`, "NO_ADAPTER")
    }
    return registration
  }

  private failureOf(provider: string, error: unknown): JevFailure {
    if (error instanceof JevError) {
      return { provider, code: error.code, message: error.message }
    }
    return {
      provider,
      code: "UNKNOWN",
      message: error instanceof Error ? error.message : String(error),
    }
  }

  private recordFallback(chain: JevChain, index: number, provider: string, failure: JevFailure): void {
    chain.onFallback?.(index, provider, failure)
    this.ctx.logger("jev").warn(
      "JEV 降级链 %s 候选 %s 失败（%s），尝试下一个",
      chain.name,
      provider,
      failure.code,
    )
  }
}
