import type { EmbeddingProviderInfo, EmbeddingRequest, EmbeddingResult } from "./types.js"

/**
 * 嵌入 Provider 的协议适配器。
 *
 * 子类只负责把已经过核心层校验的批量请求翻译成 Provider 请求，
 * 再把 Provider 响应翻译回 `EmbeddingResult`。HTTP、测试替身或本地
 * 实现都通过该接口注册。
 */
export abstract class EmbeddingAdapter {
  /** 返回一个注册路由的展示信息，默认直接使用路由名。 */
  providerInfo(provider: string): EmbeddingProviderInfo {
    return { id: provider, name: provider }
  }

  /** 执行一次已经过核心层校验的批量嵌入请求。 */
  abstract embed(request: EmbeddingRequest): Promise<EmbeddingResult>
}
