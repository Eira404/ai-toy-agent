import { JevError } from "toy-jev"

/** TypeSafe HTTP 适配器配置。地址与凭据由宿主选择；模型不在此处，由调用时的 `JevRequest.model` 提供。 */
export interface JevTypesafeConfig {
  readonly provider?: string
  readonly providerName?: string
  readonly baseURL: string
  readonly apiKey: string
  readonly timeoutMs?: number
  readonly headers?: Readonly<Record<string, string>>
  /** 测试可以注入传输实现，默认使用全局 fetch。 */
  readonly fetch?: typeof globalThis.fetch
}

/** 校验后供每次 HTTP 调用使用的私有配置快照。 */
export interface ResolvedConfig {
  readonly provider: string
  readonly providerName: string
  readonly endpoint: string
  readonly timeoutMs: number
  readonly headers: Headers
  readonly fetch: typeof globalThis.fetch
}

const PATH = "/typesafe/v1/systemone"

/** 规范化服务地址、认证头和模型配置。 */
export function resolveConfig(config: JevTypesafeConfig): ResolvedConfig {
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
    throw new JevError("JEV baseURL 无效", "INVALID_REQUEST", { cause: error })
  }
  const pathname = endpoint.pathname.replace(/\/+$/, "")
  endpoint.pathname = pathname.endsWith(PATH) ? pathname : pathname + PATH

  const timeoutMs = config.timeoutMs ?? 60_000
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) {
    throw new JevError("timeoutMs 超出有效毫秒范围", "INVALID_REQUEST")
  }
  const apiKey = config.apiKey.trim()
  if (apiKey.length === 0) {
    throw new JevError("JEV apiKey 必须是非空字符串", "INVALID_REQUEST")
  }
  const provider = config.provider?.trim() || "typesafe"
  const headers = new Headers(config.headers)
  headers.set("authorization", `Bearer ${apiKey}`)
  headers.set("content-type", "application/json")
  headers.set("accept", "application/json")
  return {
    provider,
    providerName: config.providerName ?? provider,
    endpoint: endpoint.href,
    timeoutMs,
    headers,
    fetch: config.fetch ?? globalThis.fetch,
  }
}
