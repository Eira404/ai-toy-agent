import type { GenerateOptions, LlmProviderInfo, StreamChunk } from "./types.js"

/**
 * Provider 协议适配器。
 *
 * 子类只负责把统一请求翻译成 Provider 请求，再把 Provider 流翻译回 StreamChunk。
 */
export abstract class LlmAdapter {
  /** 返回一个注册路由的展示信息，默认直接使用路由名。 */
  providerInfo(provider: string): LlmProviderInfo {
    return {
      id: provider,
      name: provider,
      protocol: "custom",
      capabilities: {
        functionTools: true,
        builtinTools: [],
        jsonSchema: true,
        reasoning: true,
      },
    }
  }

  /** 发起一次模型调用；实现必须响应 `options.signal`。 */
  abstract stream(options: GenerateOptions): AsyncIterable<StreamChunk>
}
