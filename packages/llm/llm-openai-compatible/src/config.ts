import { LlmError } from "toy-llm"
import type { RequestDefaults } from "./wire.js"

/** Chat Completions 路由配置。fetch 可替换为本地测试传输。 */
export interface OpenAICompatibleConfig extends RequestDefaults {
  readonly provider?: string
  readonly providerName?: string
  /** HTTP(S) API 根地址，也可传入完整的 chat/completions 地址。 */
  readonly baseURL: string
  readonly apiKey?: string
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
  readonly fetch: typeof globalThis.fetch
  readonly defaults: RequestDefaults
}

/** 校验连接参数并生成每次调用共用的请求默认值。 */
export function resolveConfig(config: OpenAICompatibleConfig): ResolvedConfig {
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
    throw new LlmError("LLM baseURL 无效", "INVALID_REQUEST", { cause: error })
  }
  const pathname = endpoint.pathname.replace(/\/+$/, "")
  endpoint.pathname = pathname.endsWith("/chat/completions")
    ? pathname
    : `${pathname}/chat/completions`

  const timeoutMs = config.timeoutMs ?? 300_000
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) {
    throw new LlmError("timeoutMs 超出有效毫秒范围", "INVALID_REQUEST")
  }
  const { enableThinking, thinkingBudget, toolStream } = config
  if (
    thinkingBudget !== undefined &&
    (!Number.isSafeInteger(thinkingBudget) || thinkingBudget < 1)
  ) {
    throw new LlmError("thinkingBudget 必须是正整数", "INVALID_REQUEST")
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
  const provider = config.provider?.trim() || "openai-compatible"
  return {
    provider,
    providerName: config.providerName ?? provider,
    endpoint,
    headers,
    timeoutMs,
    fetch: config.fetch ?? globalThis.fetch,
    defaults: {
      ...(enableThinking === undefined ? {} : { enableThinking }),
      ...(thinkingBudget === undefined ? {} : { thinkingBudget }),
      ...(toolStream === undefined ? {} : { toolStream }),
    },
  }
}
