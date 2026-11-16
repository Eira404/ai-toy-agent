import { EmbeddingError } from "toy-embedding"

/** OpenAI 兼容嵌入路由的配置。fetch 可替换为本地测试传输。 */
export interface OpenAICompatibleEmbeddingConfig {
  readonly provider?: string
  readonly providerName?: string
  /** HTTP(S) API 根地址，也可传入完整的 /embeddings 地址。 */
  readonly baseURL: string
  readonly apiKey?: string
  /** 可选：写入请求体的维度。Provider 支持时用于限制输出向量长度。 */
  readonly dimensions?: number
  /** 可选：单次请求最多发送的文本数。超过则分块请求并按原始顺序合并。 */
  readonly batchSize?: number
  readonly headers?: Readonly<Record<string, string>>
  readonly timeoutMs?: number
  readonly fetch?: typeof globalThis.fetch
}

/** 已校验并复制的适配器配置。 */
export interface ResolvedConfig {
  readonly provider: string
  readonly providerName: string
  readonly endpoint: URL
  readonly headers: Headers
  readonly timeoutMs: number
  readonly dimensions?: number
  readonly batchSize?: number
  readonly fetch: typeof globalThis.fetch
}

/** 校验连接参数并生成每次调用共用的配置快照。 */
export function resolveConfig(config: OpenAICompatibleEmbeddingConfig): ResolvedConfig {
  let endpoint: URL
  try {
    endpoint = new URL(config.baseURL)
    if (
      !["http:", "https:"].includes(endpoint.protocol) ||
      endpoint.username ||
      endpoint.password
    ) {
      throw new Error("需要不含用户信息的 HTTP(S) 地址")
    }
  } catch (error) {
    throw new EmbeddingError("Embedding baseURL 无效", "INVALID_REQUEST", { cause: error })
  }
  const pathname = endpoint.pathname.replace(/\/+$/, "")
  endpoint.pathname = pathname.endsWith("/embeddings") ? pathname : `${pathname}/embeddings`

  const timeoutMs = config.timeoutMs ?? 300_000
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) {
    throw new EmbeddingError("timeoutMs 超出有效毫秒范围", "INVALID_REQUEST")
  }
  if (
    config.dimensions !== undefined &&
    (!Number.isSafeInteger(config.dimensions) || config.dimensions < 1)
  ) {
    throw new EmbeddingError("dimensions 必须是正整数", "INVALID_REQUEST")
  }
  if (
    config.batchSize !== undefined &&
    (!Number.isSafeInteger(config.batchSize) || config.batchSize < 1)
  ) {
    throw new EmbeddingError("batchSize 必须是正整数", "INVALID_REQUEST")
  }

  const headers = new Headers(config.headers)
  headers.set("content-type", "application/json")
  headers.set("accept", "application/json")
  if (config.apiKey !== undefined) {
    const key = config.apiKey.trim()
    if (key.length === 0) {
      throw new EmbeddingError("API Key 为空", "INVALID_CREDENTIAL")
    }
    headers.set("authorization", `Bearer ${key}`)
  }
  const provider = config.provider?.trim() || "openai-compatible"
  return {
    provider,
    providerName: config.providerName ?? provider,
    endpoint,
    headers,
    timeoutMs,
    ...(config.dimensions === undefined ? {} : { dimensions: config.dimensions }),
    ...(config.batchSize === undefined ? {} : { batchSize: config.batchSize }),
    fetch: config.fetch ?? globalThis.fetch,
  }
}
