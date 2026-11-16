import {
  LlmAdapter,
  LlmError,
  parseSse,
  responseError,
  type GenerateOptions,
  type LlmProviderInfo,
  type StreamChunk,
} from "toy-llm"
import { resolveConfig, type OpenAIResponsesConfig, type ResolvedConfig } from "./config.js"
import { makeContinuation } from "./continuation.js"
import { OpenAIResponsesStreamTranslator } from "./translator.js"
import { serializeRequest } from "./wire.js"

/** 执行 Responses HTTP 请求并通过 toy-llm 的通用流协议输出。 */
export class OpenAIResponsesAdapter extends LlmAdapter {
  readonly provider: string
  private readonly config: ResolvedConfig

  /** @param config 路由、端点、认证、保存方式与可选的测试传输。 */
  constructor(config: OpenAIResponsesConfig) {
    super()
    this.config = resolveConfig(config)
    this.provider = this.config.provider
  }

  /** @returns 当前路由支持的模型能力与服务端内置工具列表。 */
  override providerInfo(provider: string): LlmProviderInfo {
    return {
      id: provider,
      name: this.config.providerName,
      protocol: "responses",
      capabilities: structuredClone(this.config.capabilities),
    }
  }

  /**
   * 发起一次 Responses 流式调用。遇到本地工具调用时，结束前输出供下次请求使用的续调句柄。
   *
   * @param options 请求参数。调用方用 signal 中断网络读取，用 continuation 回传工具结果。
   * @returns 统一流事件。完整消费到 finish 后可以释放底层连接。
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
      const request = serializeRequest(options, this.config)
      const response = await this.config.fetch(this.config.endpoint, {
        method: "POST",
        redirect: "error",
        headers: new Headers(this.config.headers),
        body: JSON.stringify(request),
        signal,
      })
      signal.throwIfAborted()
      if (!response.ok) {
        throw await responseError(response)
      }
      if (response.body === null) {
        throw new LlmError("Provider 没有返回响应体", "EMPTY_RESPONSE")
      }

      const translator = new OpenAIResponsesStreamTranslator()
      for await (const event of parseSse(response.body, signal)) {
        yield* translator.push(event)
        const terminal = translator.terminal
        if (terminal !== undefined) {
          if (terminal.reason.kind === "tool-calls") {
            yield {
              type: "continuation",
              continuation: makeContinuation(
                options,
                this.config.store,
                request.input,
                terminal.id,
                terminal.output,
                terminal.callIds,
              ),
            }
          }
          yield { type: "finish", reason: terminal.reason }
          return
        }
      }
      throw new LlmError("Responses 流缺少终止事件", "STREAM_CLOSED")
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
