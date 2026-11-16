import {
  LlmAdapter,
  LlmError,
  parseSse,
  responseError,
  type GenerateOptions,
  type LlmProviderInfo,
  type StreamChunk,
} from "toy-llm"
import { resolveConfig, type OpenAICompatibleConfig, type ResolvedConfig } from "./config.js"
import { OpenAIStreamTranslator } from "./translator.js"
import { serializeRequest } from "./wire.js"

/** 使用 fetch 执行一次 Chat Completions 请求，将 SSE 转成统一模型事件。 */
export class OpenAICompatibleAdapter extends LlmAdapter {
  readonly provider: string
  private readonly config: ResolvedConfig

  /** @param config 路由、端点、认证和可注入的 fetch 实现。 */
  constructor(config: OpenAICompatibleConfig) {
    super()
    this.config = resolveConfig(config)
    this.provider = this.config.provider
  }

  /** @returns 该路由可用于模型请求和工具筛选的协议信息。 */
  override providerInfo(provider: string): LlmProviderInfo {
    return {
      id: provider,
      name: this.config.providerName,
      protocol: "chat-completions",
      capabilities: { functionTools: true, builtinTools: [], jsonSchema: true, reasoning: true },
    }
  }

  /**
   * 发起一次流式请求。完整消费会收到一个结束事件，异常由 LLM 服务归一化。
   *
   * @param options 统一请求参数。signal 用于中断连接和响应读取。
   * @returns 可逐段消费的模型事件流。
   */
  override async *stream(options: GenerateOptions): AsyncGenerator<StreamChunk> {
    const consumer = new AbortController()
    const timeout = new AbortController()
    const timer = setTimeout(() => timeout.abort(), this.config.timeoutMs)
    const signal = AbortSignal.any([
      consumer.signal,
      timeout.signal,
      ...(options.signal === undefined ? [] : [options.signal]),
    ])

    try {
      signal.throwIfAborted()
      const body = JSON.stringify(serializeRequest(options, this.config.defaults))
      const response = await this.config.fetch(this.config.endpoint.href, {
        method: "POST",
        redirect: "error",
        headers: new Headers(this.config.headers),
        body,
        signal,
      })
      signal.throwIfAborted()
      if (!response.ok) {
        throw await responseError(response)
      }
      if (response.body === null) {
        throw new LlmError("Provider 没有返回响应体", "EMPTY_RESPONSE")
      }

      const translator = new OpenAIStreamTranslator()
      for await (const event of parseSse(response.body, signal)) {
        yield* translator.push(event)
      }
      yield* translator.finish()
    } catch (error) {
      if (options.signal?.aborted) {
        throw new LlmError("LLM 请求已取消", "ABORTED", { cause: error })
      }
      if (timeout.signal.aborted) {
        throw new LlmError("LLM 请求超时", "TIMEOUT", { cause: error })
      }
      if (error instanceof LlmError) {
        throw error
      }
      throw new LlmError("LLM 网络请求失败", "TRANSPORT", { cause: error })
    } finally {
      clearTimeout(timer)
      consumer.abort()
    }
  }
}
