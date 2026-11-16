import { Service, type Context } from "cordis"
import { JevTypesafeAdapter } from "./adapter.js"
import type { JevTypesafeConfig } from "./config.js"

export { JevTypesafeAdapter }
export type { JevTypesafeConfig }

/**
 * 挂载一个 JEV TypeSafe 路由的 Cordis 类插件。
 * 通过 `config.provider` 动态命名，允许同一类以不同 provider 加载多个实例；插件卸载时注销。
 */
export class JevTypesafePlugin extends Service {
  static inject = ["jev"]

  constructor(ctx: Context, config: JevTypesafeConfig) {
    super(ctx, `jev.typesafe.${config.provider?.trim() || "typesafe"}`)
    const adapter = new JevTypesafeAdapter(config)
    ctx.effect(
      () => ctx.jev.registerAdapter(adapter.provider, adapter),
      "jev.registerAdapter",
    )
  }
}

export default JevTypesafePlugin
