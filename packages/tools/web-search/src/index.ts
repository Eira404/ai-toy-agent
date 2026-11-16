import { Service, type Context } from "cordis"
import type { ToolRegistry } from "toy-tools"

declare module "cordis" {
  interface Context {
    webSearch: WebSearchTool
  }
}

export interface WebSearchConfig {
  /** 内置工具名，默认 `web_search`。 */
  readonly toolName?: string
  /** 工具描述，进入模型可见的工具 Schema。 */
  readonly description?: string
}

const DEFAULT_TOOL_NAME = "web_search"
const DEFAULT_DESCRIPTION = "获取实时网络信息"

/**
 * Web 搜索内置工具插件：向 `ctx.tools` 注册 `web_search` 内置工具。
 *
 * 内置工具由模型供应商在服务端执行；是否注入由 Provider 声明的 `builtinTools` 能力决定，
 * 业务侧是否可用由 `isAvailable` 决定（当前恒返回 true，后续按需加判断）。
 */
export class WebSearchTool extends Service {
  static inject = ["tools"]

  private readonly tools: ToolRegistry

  constructor(ctx: Context, config: WebSearchConfig = {}) {
    super(ctx, "webSearch")
    this.tools = ctx.tools

    const toolName = (config.toolName ?? DEFAULT_TOOL_NAME).trim()
    const description = config.description ?? DEFAULT_DESCRIPTION

    ctx.effect(
      () =>
        this.tools.registerBuiltin({
          name: toolName,
          description,
          // 未来按 scope/payload 决定是否注入；目前默认注入。
          isAvailable: () => true,
        }),
      "webSearch.registerBuiltin",
    )
  }
}

export default WebSearchTool
