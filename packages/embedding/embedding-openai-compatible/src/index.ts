import { Service, type Context } from "cordis"
import { OpenAICompatibleEmbeddingAdapter } from "./adapter.js"
import type { OpenAICompatibleEmbeddingConfig } from "./config.js"

export { OpenAICompatibleEmbeddingAdapter }
export type { OpenAICompatibleEmbeddingConfig }

/**
 * 挂载一个 OpenAI 兼容嵌入路由的 Cordis 类插件。
 * 通过 `config.provider` 动态命名，允许同一类以不同 provider 加载多个实例；插件卸载时注销。
 */
export class EmbeddingOpenAICompatiblePlugin extends Service {
  static inject = ["embedding"]

  constructor(ctx: Context, config: OpenAICompatibleEmbeddingConfig) {
    super(ctx, `embedding.openaiCompatible.${config.provider?.trim() || "openai-compatible"}`)
    const adapter = new OpenAICompatibleEmbeddingAdapter(config)
    ctx.effect(
      () => ctx.embedding.registerAdapter(adapter.provider, adapter),
      "embedding.registerAdapter",
    )
  }
}

export default EmbeddingOpenAICompatiblePlugin
