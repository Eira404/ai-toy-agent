import {
  EmbeddingAdapter,
  EmbeddingError,
  type EmbeddingProviderInfo,
  type EmbeddingRequest,
  type EmbeddingResult,
} from "toy-embedding"
import {
  resolveConfig,
  type OpenAICompatibleEmbeddingConfig,
  type ResolvedConfig,
} from "./config.js"
import { responseError } from "./http-error.js"
import { parseEmbeddings, serializeRequest, type ParsedEmbeddings } from "./wire.js"

/** 使用 fetch 执行一次 /embeddings 请求，支持分块、排序合并和维度校验。 */
export class OpenAICompatibleEmbeddingAdapter extends EmbeddingAdapter {
  readonly provider: string
  private readonly config: ResolvedConfig

  /** @param config 路由、端点、认证、维度和可注入的 fetch 实现。 */
  constructor(config: OpenAICompatibleEmbeddingConfig) {
    super()
    this.config = resolveConfig(config)
    this.provider = this.config.provider
  }

  /** @returns 该路由用于展示的协议信息。 */
  override providerInfo(provider: string): EmbeddingProviderInfo {
    return { id: provider, name: this.config.providerName }
  }

  /**
   * 发送一次批量嵌入请求。文本超过 `batchSize` 时分块请求，并按原始顺序合并。
   *
   * @param request 核心层已校验的文本、模型和可选取消信号。
   * @returns 与文本顺序一致的向量、Provider 返回的模型名和维度。
   */
  override async embed(request: EmbeddingRequest): Promise<EmbeddingResult> {
    const timeout = new AbortController()
    const timer = setTimeout(() => timeout.abort(), this.config.timeoutMs)
    const signal =
      request.signal === undefined
        ? timeout.signal
        : AbortSignal.any([request.signal, timeout.signal])
    try {
      signal.throwIfAborted()
      const chunks = this.chunkTexts(request.texts)
      const collected: { index: number; vector: readonly number[] }[] = []
      let offset = 0
      let modelId = request.model
      let dimensions = 0
      for (const chunk of chunks) {
        const parsed = await this.post(request.model, chunk, signal)
        for (const item of parsed.items) {
          collected.push({ index: offset + item.index, vector: item.vector })
        }
        modelId = parsed.modelId.length === 0 ? modelId : parsed.modelId
        dimensions = parsed.dimensions
        offset += chunk.length
      }
      collected.sort((left, right) => left.index - right.index)
      if (collected.length !== request.texts.length) {
        throw new EmbeddingError("嵌入结果数量与输入文本数量不一致", "INVALID_RESPONSE")
      }
      const vectors = collected.map((item) => item.vector)
      if (vectors.some((vector) => vector.length !== dimensions)) {
        throw new EmbeddingError("嵌入向量维度不一致", "INVALID_RESPONSE")
      }
      if (this.config.dimensions !== undefined && dimensions !== this.config.dimensions) {
        throw new EmbeddingError("Provider 返回维度与配置不一致", "INVALID_RESPONSE")
      }
      return { vectors, modelId, dimensions }
    } catch (error) {
      if (request.signal?.aborted) {
        throw new EmbeddingError("嵌入请求已取消", "ABORTED", { cause: error })
      }
      if (timeout.signal.aborted) {
        throw new EmbeddingError("嵌入请求超时", "TIMEOUT", { retryable: true, cause: error })
      }
      if (error instanceof EmbeddingError) {
        throw error
      }
      throw new EmbeddingError("嵌入网络请求失败", "TRANSPORT", { retryable: true, cause: error })
    } finally {
      clearTimeout(timer)
    }
  }

  /** 按 batchSize 切分文本；未配置时一次发送全部文本。 */
  private chunkTexts(texts: readonly string[]): readonly (readonly string[])[] {
    if (this.config.batchSize === undefined) {
      return [texts]
    }
    const chunks: string[][] = []
    for (let index = 0; index < texts.length; index += this.config.batchSize) {
      chunks.push([...texts.slice(index, index + this.config.batchSize)])
    }
    return chunks
  }

  /** 发送一次 HTTP 请求并解析响应。 */
  private async post(
    model: string,
    chunk: readonly string[],
    signal: AbortSignal,
  ): Promise<ParsedEmbeddings> {
    const body = JSON.stringify(serializeRequest(model, chunk, this.config.dimensions))
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
    let payload: unknown
    try {
      payload = await response.json()
    } catch (error) {
      throw new EmbeddingError("Provider 返回了无效 JSON", "INVALID_RESPONSE", { cause: error })
    }
    signal.throwIfAborted()
    return parseEmbeddings(payload)
  }
}
