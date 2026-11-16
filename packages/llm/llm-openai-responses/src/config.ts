import { LlmError, type LlmProviderCapabilities } from "toy-llm"

/** Responses 路由配置。store 控制本地工具续调用服务端 ID 还是重放 Item。 */
export interface OpenAIResponsesConfig {
  readonly provider?: string
  readonly providerName?: string
  /** API 根地址或完整的 /responses 地址。 */
  readonly baseURL: string
  readonly apiKey?: string
  readonly headers?: Readonly<Record<string, string>>
  readonly timeoutMs?: number
  /** 默认为 false。启用后通过 previous_response_id 续调。 */
  readonly store?: boolean
  /** 此路由允许的服务端内置工具类型，例如 web_search。 */
  readonly builtinTools?: readonly string[]
  readonly functionTools?: boolean
  readonly jsonSchema?: boolean
  readonly reasoning?: boolean
  readonly reasoningSummary?: "auto" | "concise" | "detailed"
  /** 测试可替换 HTTP 传输。默认使用全局 fetch。 */
  readonly fetch?: typeof globalThis.fetch
}

/** 已经校验且与调用方配置对象隔离的路由信息。 */
export interface ResolvedConfig {
  readonly provider: string
  readonly providerName: string
  readonly endpoint: string
  readonly headers: Headers
  readonly timeoutMs: number
  readonly store: boolean
  readonly capabilities: LlmProviderCapabilities
  readonly reasoningSummary: OpenAIResponsesConfig["reasoningSummary"]
  readonly fetch: typeof globalThis.fetch
}

/** 规范化端点、认证头、超时和路由能力。 */
export function resolveConfig(config: OpenAIResponsesConfig): ResolvedConfig {
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
    throw new LlmError("Responses baseURL 无效", "INVALID_REQUEST", { cause: error })
  }
  const pathname = endpoint.pathname.replace(/\/+$/, "")
  endpoint.pathname = pathname.endsWith("/responses") ? pathname : `${pathname}/responses`
  const timeoutMs = config.timeoutMs ?? 300_000
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) {
    throw new LlmError("timeoutMs 超出有效毫秒范围", "INVALID_REQUEST")
  }

  const headers = new Headers(config.headers)
  headers.set("content-type", "application/json")
  headers.set("accept", "text/event-stream")
  if (config.apiKey !== undefined) {
    const key = config.apiKey.trim()
    if (key.length === 0) {
      throw new LlmError("API Key 为空", "INVALID_CREDENTIAL")
    }
    headers.set("authorization", `Bearer ${key}`)
  }
  const provider = config.provider?.trim() || "openai-responses"
  return {
    provider,
    providerName: config.providerName ?? provider,
    endpoint: endpoint.href,
    headers,
    timeoutMs,
    store: config.store ?? false,
    capabilities: {
      functionTools: config.functionTools ?? true,
      builtinTools: [...(config.builtinTools ?? [])],
      jsonSchema: config.jsonSchema ?? true,
      reasoning: config.reasoning ?? true,
    },
    reasoningSummary: config.reasoningSummary,
    fetch: config.fetch ?? globalThis.fetch,
  }
}
