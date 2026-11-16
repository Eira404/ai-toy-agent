import type { JevResponse } from "./schema.js"
import type { JevRequest } from "./types.js"

/** JEV Provider 的展示信息。 */
export interface JevProviderInfo {
  readonly id: string
  readonly name: string
}

/** JEV 协议适配器；HTTP、测试替身或本地实现都通过该接口注册。 */
export abstract class JevAdapter {
  /** 默认直接使用注册路由名作为展示信息。 */
  providerInfo(provider: string): JevProviderInfo {
    return { id: provider, name: provider }
  }

  /** 执行一次已经过核心层校验的 JEV 请求。 */
  abstract invoke(request: JevRequest): Promise<JevResponse>
}
