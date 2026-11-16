import {
  JevAdapter,
  JevError,
  JevResponseSchema,
  type JevProviderInfo,
  type JevRequest,
  type JevResponse,
} from "toy-jev"
import { resolveConfig, type JevTypesafeConfig, type ResolvedConfig } from "./config.js"
import { responseError } from "./http-error.js"

/** 执行 TypeSafe JSON 请求的 JEV 适配器。 */
export class JevTypesafeAdapter extends JevAdapter {
  readonly provider: string
  private readonly config: ResolvedConfig

  /** @param config 路由、模型、端点、凭据和请求时限。 */
  constructor(config: JevTypesafeConfig) {
    super()
    this.config = resolveConfig(config)
    this.provider = this.config.provider
  }

  override providerInfo(provider: string): JevProviderInfo {
    return { id: provider, name: this.config.providerName }
  }

  /**
   * 发送一次 TypeSafe 请求，HTTP 错误会携带重试提示。
   *
   * @param request JEV 核心已校验的文本、问题和可选取消信号。
   * @returns 通过响应 Schema 校验的数据。问题与答案的匹配由 JEV 核心检查。
   */
  override async invoke(request: JevRequest): Promise<JevResponse> {
    const timeout = new AbortController()
    const timer = setTimeout(() => timeout.abort(), this.config.timeoutMs)
    const signal =
      request.signal === undefined
        ? timeout.signal
        : AbortSignal.any([request.signal, timeout.signal])
    try {
      signal.throwIfAborted()
      const response = await this.config.fetch(this.config.endpoint, {
        method: "POST",
        redirect: "error",
        headers: new Headers(this.config.headers),
        body: JSON.stringify({
          model: request.model,
          state: request.state,
          questions: request.questions,
        }),
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
        throw new JevError("JEV 接口返回了无效 JSON", "INVALID_RESPONSE", { cause: error })
      }
      signal.throwIfAborted()
      const parsed = JevResponseSchema.safeParse(payload)
      if (!parsed.success) {
        throw new JevError("JEV 响应格式无效", "INVALID_RESPONSE", { cause: parsed.error })
      }
      return parsed.data
    } catch (error) {
      if (request.signal?.aborted) {
        throw new JevError("JEV 请求已取消", "ABORTED", { cause: request.signal.reason })
      }
      if (timeout.signal.aborted) {
        throw new JevError("JEV 请求超时", "TIMEOUT", { retryable: true, cause: error })
      }
      if (error instanceof JevError) {
        throw error
      }
      throw new JevError("JEV 网络请求失败", "TRANSPORT", { retryable: true, cause: error })
    } finally {
      clearTimeout(timer)
    }
  }
}
