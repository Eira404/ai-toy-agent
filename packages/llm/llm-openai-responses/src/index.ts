import { Service, type Context } from "cordis"
import { OpenAIResponsesAdapter } from "./adapter.js"
import type { OpenAIResponsesConfig } from "./config.js"

export { OpenAIResponsesAdapter }
export type { OpenAIResponsesConfig }

/**
 * 挂载一个 Responses 路由的 Cordis 类插件。
 * 通过 `config.provider` 动态命名，允许同一类以不同 provider 加载多个实例；插件卸载时注销。
 */
export class OpenAIResponsesPlugin extends Service {
  static inject = ["llm"]

  constructor(ctx: Context, config: OpenAIResponsesConfig) {
    super(ctx, `llm.openaiResponses.${config.provider?.trim() || "openai-responses"}`)
    const adapter = new OpenAIResponsesAdapter(config)
    ctx.effect(
      () => ctx.llm.registerAdapter(adapter.provider, adapter),
      "llm.registerAdapter",
    )
  }
}

export default OpenAIResponsesPlugin
