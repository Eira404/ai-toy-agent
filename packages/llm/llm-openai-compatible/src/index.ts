import { Service, type Context } from "cordis"
import { OpenAICompatibleAdapter } from "./adapter.js"
import type { OpenAICompatibleConfig } from "./config.js"

export { OpenAICompatibleAdapter }
export type { OpenAICompatibleConfig }

/**
 * 挂载一个 Chat Completions 路由的 Cordis 类插件。
 * 通过 `config.provider` 动态命名，允许同一类以不同 provider 加载多个实例；插件卸载时注销。
 */
export class OpenAICompatiblePlugin extends Service {
  static inject = ["llm"]

  constructor(ctx: Context, config: OpenAICompatibleConfig) {
    super(ctx, `llm.openaiCompatible.${config.provider?.trim() || "openai-compatible"}`)
    const adapter = new OpenAICompatibleAdapter(config)
    ctx.effect(
      () => ctx.llm.registerAdapter(adapter.provider, adapter),
      "llm.registerAdapter",
    )
  }
}

export default OpenAICompatiblePlugin
