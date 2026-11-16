import { Service, type Context } from "cordis"
import type { LlmAdapter } from "./adapter.js"
import { BlockAssembler } from "./assembler.js"
import { LlmError, normalizeLlmFailure } from "./error.js"
import type {
  GenerateOptions,
  GenerateResult,
  LlmChainOptions,
  LlmFailure,
  LlmFallbackPredicate,
  LlmProviderInfo,
  LlmRouteEntry,
  StreamChunk,
} from "./types.js"

declare module "cordis" {
  interface Context {
    llm: LlmRuntime
  }
}

/** 已注册的模型路由及其能力快照。 */
interface Registration {
  readonly adapter: LlmAdapter
  readonly info: LlmProviderInfo
}

/** 已注册的降级链：有序候选列表，第一个是默认。 */
interface ChainRegistration {
  readonly name: string
  readonly entries: readonly LlmRouteEntry[]
  readonly retryable: LlmFallbackPredicate
  readonly onFallback?: LlmChainOptions["onFallback"]
}

/** provider 名称解析结果：单适配器或降级链。 */
type Route =
  | { readonly kind: "adapter"; readonly registration: Registration }
  | { readonly kind: "chain"; readonly chain: ChainRegistration }

/** 默认可降级失败：临时性传输/超时/流异常，以及 408、429 和 5xx。 */
const RETRYABLE_CODES = new Set([
  "TRANSPORT",
  "TIMEOUT",
  "EMPTY_RESPONSE",
  "STREAM_CLOSED",
  "MALFORMED_STREAM",
])

function isRetryableFailure(failure: LlmFailure): boolean {
  if (failure.code === "ABORTED") {
    return false
  }
  if (RETRYABLE_CODES.has(failure.code)) {
    return true
  }
  const status = failure.status
  return status === 408 || status === 429 || (status !== undefined && status >= 500)
}

/** 挂载到 `ctx.llm` 的模型服务。适配器按名称注册，降级链按候选顺序自动降级。 */
export class LlmRuntime extends Service {
  private readonly adapters = new Map<string, Registration>()
  private readonly chains = new Map<string, ChainRegistration>()

  constructor(ctx: Context) {
    super(ctx, "llm")
  }

  /**
   * 注册一个可用于 `stream` 或 `generate` 的模型路由。
   *
   * @param provider 请求使用的路由名，例如 `"chat"`。
   * @param adapter 将通用请求和流片段转换为供应商协议的适配器。
   * @returns 幂等注销函数。插件可以用 `ctx.effect` 在卸载时自动调用。
   */
  registerAdapter(provider: string, adapter: LlmAdapter): () => void {
    const id = provider.trim()
    if (id.length === 0) {
      throw new LlmError("Provider 名称不能为空", "INVALID_REQUEST")
    }
    if (this.adapters.has(id) || this.chains.has(id)) {
      throw new LlmError(`Provider '${id}' 已注册`, "DUPLICATE_ADAPTER")
    }
    const info = structuredClone(adapter.providerInfo(id))
    if (info.id !== id) {
      throw new LlmError("Provider 信息中的 id 必须与注册名称一致", "INVALID_REQUEST")
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
   * 注册一个降级链路由：按顺序尝试各候选，前一个可降级失败则尝试下一个。
   *
   * @param name 逻辑路由名，例如 `"main"`。调用时用它作为 `options.provider`。
   * @param entries 有序候选列表，第一个是默认。每个候选的 provider 必须已注册。
   * @param options 可选的重试判定与降级回调。
   * @returns 幂等注销函数。
   */
  registerChain(
    name: string,
    entries: readonly LlmRouteEntry[],
    options: LlmChainOptions = {},
  ): () => void {
    const id = name.trim()
    if (id.length === 0) {
      throw new LlmError("降级链名称不能为空", "INVALID_REQUEST")
    }
    if (this.adapters.has(id) || this.chains.has(id)) {
      throw new LlmError(`Provider '${id}' 已注册`, "DUPLICATE_ADAPTER")
    }
    const normalized: LlmRouteEntry[] = entries.map((entry) => ({
      provider: entry.provider.trim(),
      model: entry.model.trim(),
    }))
    if (normalized.length === 0) {
      throw new LlmError("降级链至少需要一个候选", "INVALID_REQUEST")
    }
    for (const entry of normalized) {
      if (entry.provider.length === 0 || entry.model.length === 0) {
        throw new LlmError("降级链候选的 provider 和 model 不能为空", "INVALID_REQUEST")
      }
      if (!this.adapters.has(entry.provider)) {
        throw new LlmError(
          `降级链候选 Provider '${entry.provider}' 没有注册 Adapter`,
          "NO_ADAPTER",
        )
      }
    }
    const registration: ChainRegistration = {
      name: id,
      entries: normalized,
      retryable: options.retryable ?? isRetryableFailure,
      onFallback: options.onFallback,
    }
    this.chains.set(id, registration)
    return () => {
      if (this.chains.get(id) === registration) {
        this.chains.delete(id)
      }
    }
  }

  /** @returns 按注册顺序排列的路由和能力快照（单适配器在前，降级链在后）。 */
  listProviders(): readonly LlmProviderInfo[] {
    const adapters = [...this.adapters.values()].map(({ info }) => structuredClone(info))
    const chains = [...this.chains.values()].map((chain) => this.chainInfo(chain))
    return [...adapters, ...chains]
  }

  /**
   * @param provider 要查询的已注册路由或降级链。
   * @returns 可用于筛选工具和请求选项的能力快照；降级链返回所有候选的能力交集。
   */
  providerInfo(provider: string): LlmProviderInfo {
    const route = this.resolveRoute(provider)
    return route.kind === "adapter"
      ? structuredClone(route.registration.info)
      : this.chainInfo(route.chain)
  }

  /**
   * 发起一次模型调用并逐步返回内容、工具调用、用量和结束事件。
   *
   * @param options 指定 provider、model、消息及可选工具和取消信号。provider 命中降级链时按序降级。
   * @returns 可通过 `for await` 消费的流。完整消费时以一个 `finish` 事件结束，调用失败和取消也通过该事件表示。
   */
  async *stream(options: GenerateOptions): AsyncGenerator<StreamChunk> {
    let route: Route
    try {
      options.signal?.throwIfAborted()
      route = this.resolveRoute(options.provider)
    } catch (error) {
      yield failureChunk(error, options.signal)
      return
    }
    if (route.kind === "adapter") {
      yield* this.streamAdapter(options, route.registration.adapter)
    } else {
      yield* this.streamChain(options, route.chain)
    }
  }

  /**
   * 使用与 `stream` 相同的协议发起一次调用，返回组装后的结果。
   *
   * @param options 单次模型调用的输入。
   * @returns 内容块、可选用量和结束原因。执行工具前应检查 `finish.kind`。
   */
  async generate(options: GenerateOptions): Promise<GenerateResult> {
    let route: Route
    try {
      options.signal?.throwIfAborted()
      route = this.resolveRoute(options.provider)
    } catch (error) {
      return this.failureResult(error, options.signal)
    }
    if (route.kind === "adapter") {
      return this.generateAdapter(options, route.registration.adapter)
    }
    return this.generateChain(options, route.chain)
  }

  private async *streamAdapter(
    options: GenerateOptions,
    adapter: LlmAdapter,
  ): AsyncGenerator<StreamChunk> {
    let iterator: AsyncIterator<StreamChunk>
    try {
      iterator = adapter.stream(options)[Symbol.asyncIterator]()
    } catch (error) {
      yield failureChunk(error, options.signal)
      return
    }

    try {
      while (true) {
        let next: IteratorResult<StreamChunk>
        try {
          options.signal?.throwIfAborted()
          next = await iterator.next()
          options.signal?.throwIfAborted()
        } catch (error) {
          yield failureChunk(error, options.signal)
          return
        }
        if (next.done) {
          yield failureChunk(new LlmError("模型流缺少终止事件", "STREAM_CLOSED"))
          return
        }
        // 消费方在 yield 处提前结束时，也会经过 finally 释放底层流。
        yield next.value
        if (next.value.type === "finish") {
          return
        }
      }
    } finally {
      try {
        await iterator.return?.()
      } catch (error) {
        this.ctx.logger("llm").warn("清理模型流失败：%o", error)
      }
    }
  }

  private async *streamChain(
    options: GenerateOptions,
    chain: ChainRegistration,
  ): AsyncGenerator<StreamChunk> {
    const failures: LlmFailure[] = []
    for (let index = 0; index < chain.entries.length; index += 1) {
      const entry = chain.entries[index]!
      if (options.signal?.aborted) {
        yield failureChunk(new LlmError("LLM 请求已取消", "ABORTED"), options.signal)
        return
      }
      const attempt = this.attemptOptions(options, entry)
      // 一旦向调用方吐出了任何内容，就不能再静默切换模型，避免两段输出拼在一起。
      let emittedAny = false

      const iterator = this.requireAdapter(entry.provider).adapter.stream(attempt)[Symbol.asyncIterator]()
      try {
        while (true) {
          let next: IteratorResult<StreamChunk>
          try {
            options.signal?.throwIfAborted()
            next = await iterator.next()
            options.signal?.throwIfAborted()
          } catch (error) {
            if (options.signal?.aborted) {
              yield failureChunk(error, options.signal)
              return
            }
            const failure = normalizeLlmFailure(error)
            if (emittedAny || !chain.retryable(failure)) {
              yield failureChunk(error, options.signal)
              return
            }
            failures.push(failure)
            this.recordFallback(chain, index, entry, failure)
            break
          }
          if (next.done) {
            const failure = normalizeLlmFailure(
              new LlmError("模型流缺少终止事件", "STREAM_CLOSED"),
            )
            if (emittedAny || !chain.retryable(failure)) {
              yield failureChunk(new LlmError("模型流缺少终止事件", "STREAM_CLOSED"))
              return
            }
            failures.push(failure)
            this.recordFallback(chain, index, entry, failure)
            break
          }
          const chunk = next.value
          if (chunk.type === "finish") {
            if (
              chunk.reason.kind === "error" &&
              !emittedAny &&
              chain.retryable(chunk.reason.failure)
            ) {
              failures.push(chunk.reason.failure)
              this.recordFallback(chain, index, entry, chunk.reason.failure)
              break
            }
            yield chunk
            return
          }
          emittedAny = true
          yield chunk
        }
      } finally {
        try {
          await iterator.return?.()
        } catch (error) {
          this.ctx.logger("llm").warn("清理模型流失败：%o", error)
        }
      }
    }
    yield failureChunk(this.exhaustedError(chain, failures), options.signal)
  }

  private async generateAdapter(
    options: GenerateOptions,
    adapter: LlmAdapter,
  ): Promise<GenerateResult> {
    const assembler = new BlockAssembler()
    for await (const chunk of this.streamAdapter(options, adapter)) {
      assembler.push(chunk)
    }
    return assembler.result()
  }

  private async generateChain(
    options: GenerateOptions,
    chain: ChainRegistration,
  ): Promise<GenerateResult> {
    const failures: LlmFailure[] = []
    for (let index = 0; index < chain.entries.length; index += 1) {
      const entry = chain.entries[index]!
      if (options.signal?.aborted) {
        return this.failureResult(new LlmError("LLM 请求已取消", "ABORTED"), options.signal)
      }
      const attempt = this.attemptOptions(options, entry)
      const result = await this.generateAdapter(attempt, this.requireAdapter(entry.provider).adapter)
      if (result.finish.kind === "error" && chain.retryable(result.finish.failure)) {
        failures.push(result.finish.failure)
        this.recordFallback(chain, index, entry, result.finish.failure)
        continue
      }
      return result
    }
    return this.failureResult(this.exhaustedError(chain, failures), options.signal)
  }

  private resolveRoute(provider: string): Route {
    const id = provider.trim()
    const adapter = this.adapters.get(id)
    if (adapter !== undefined) {
      return { kind: "adapter", registration: adapter }
    }
    const chain = this.chains.get(id)
    if (chain !== undefined) {
      return { kind: "chain", chain }
    }
    throw new LlmError(`Provider '${provider}' 没有注册 Adapter`, "NO_ADAPTER")
  }

  private requireAdapter(provider: string): Registration {
    const registration = this.adapters.get(provider)
    if (registration === undefined) {
      throw new LlmError(`Provider '${provider}' 没有注册 Adapter`, "NO_ADAPTER")
    }
    return registration
  }

  private chainInfo(chain: ChainRegistration): LlmProviderInfo {
    const infos = chain.entries.map((entry) => this.requireAdapter(entry.provider).info)
    const capabilities = {
      functionTools: infos.every((info) => info.capabilities.functionTools),
      builtinTools: infos[0]!.capabilities.builtinTools.filter((name) =>
        infos.every((info) => info.capabilities.builtinTools.includes(name)),
      ),
      jsonSchema: infos.every((info) => info.capabilities.jsonSchema),
      reasoning: infos.every((info) => info.capabilities.reasoning),
    }
    const protocols = new Set(infos.map((info) => info.protocol))
    return {
      id: chain.name,
      name: chain.name,
      protocol: protocols.size === 1 ? [...protocols][0]! : "custom",
      capabilities,
    }
  }

  private attemptOptions(options: GenerateOptions, entry: LlmRouteEntry): GenerateOptions {
    // 切换候选时，若续调句柄指向其它 provider/model，则丢弃，避免把旧模型状态交给新模型。
    const continuation =
      options.continuation !== undefined &&
      options.continuation.provider === entry.provider &&
      options.continuation.model === entry.model
        ? options.continuation
        : undefined
    const { continuation: _continuation, ...rest } = options
    return {
      ...rest,
      provider: entry.provider,
      model: entry.model,
      ...(continuation === undefined ? {} : { continuation }),
    }
  }

  private recordFallback(
    chain: ChainRegistration,
    index: number,
    entry: LlmRouteEntry,
    failure: LlmFailure,
  ): void {
    chain.onFallback?.(index, entry, failure)
    this.ctx.logger("llm").warn(
      "降级链 %s 候选 %s/%s 失败（%s），尝试下一个",
      chain.name,
      entry.provider,
      entry.model,
      failure.code,
    )
  }

  private exhaustedError(chain: ChainRegistration, failures: readonly LlmFailure[]): LlmError {
    return new LlmError(`降级链 '${chain.name}' 的所有候选均失败`, "FALLBACK_EXHAUSTED", {
      attempts: failures,
    })
  }

  private failureResult(error: unknown, signal?: AbortSignal): GenerateResult {
    const assembler = new BlockAssembler()
    assembler.push(failureChunk(error, signal))
    return assembler.result()
  }
}

/** 将供应商异常或调用取消统一为流的终止事件。 */
function failureChunk(error: unknown, signal?: AbortSignal): StreamChunk {
  const failure = normalizeLlmFailure(error)
  return {
    type: "finish",
    reason:
      signal?.aborted || failure.code === "ABORTED"
        ? { kind: "aborted", failure: { ...failure, code: "ABORTED" } }
        : { kind: "error", failure },
  }
}
