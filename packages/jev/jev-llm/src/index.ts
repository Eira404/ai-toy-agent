import { Service, type Context } from "cordis"
import { JevLlmAdapter } from "./adapter.js"
import type { JevLlmConfig } from "./config.js"

export { JevLlmAdapter }
export type { JevLlmConfig }

/**
 * 挂载一个「LLM 兜底」JEV 路由的 Cordis 类插件。
 * 通过 `config.provider` 动态命名，允许同一类以不同 provider 加载多个实例；插件卸载时注销。
 */
export class JevLlmPlugin extends Service {
  static inject = ["jev", "llm"]

  constructor(ctx: Context, config: JevLlmConfig) {
    super(ctx, `jev.llm.${config.provider?.trim() || "llm"}`)
    const adapter = new JevLlmAdapter(ctx.llm, config)
    ctx.effect(
      () => ctx.jev.registerAdapter(adapter.provider, adapter),
      "jev.registerAdapter",
    )
  }
}

export default JevLlmPlugin
