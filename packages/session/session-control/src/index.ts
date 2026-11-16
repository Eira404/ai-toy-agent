import { Service, type Context } from "cordis"
import type { ToolExecutionContext } from "toy-tools"
import type { ToySession } from "toy-session"

declare module "cordis" {
  interface Context {
    sessionControl: SessionControl
  }
}

export interface SessionControlConfig {
  /** 关闭会话工具名，默认 `close_session`。 */
  readonly toolName?: string
  /** 工具描述，进入模型可见的工具 Schema，用于引导模型在告别时调用。 */
  readonly toolDescription?: string
  /** 工具执行后返回给模型的内容，用于引导模型礼貌告别。 */
  readonly farewellInstruction?: string
}

const DEFAULT_TOOL_NAME = "close_session"
const DEFAULT_DESCRIPTION =
  "当用户明确表达再见、告别、结束对话等终止对话的意图时调用，关闭当前会话。"
const DEFAULT_INSTRUCTION = "会话已标记为关闭。请礼貌地向用户告别，用自然、友好的语气结束本次对话。"

/**
 * 会话控制插件：注册一个「关闭会话」的本地工具。
 *
 * 模型在用户告别时调用该工具；工具把关闭动作挂到当前 Turn 之后（fire-and-forget，不 await，
 * 否则会死锁），并返回一句指令引导模型输出道别语。当前 Turn 会正常跑完，随后 Session 进入
 * closing。
 */
export class SessionControl extends Service {
  static inject = ["session", "tools"]

  private readonly session: ToySession

  constructor(ctx: Context, config: SessionControlConfig = {}) {
    super(ctx, "sessionControl")
    this.session = ctx.session

    const toolName = (config.toolName ?? DEFAULT_TOOL_NAME).trim()
    const description = config.toolDescription ?? DEFAULT_DESCRIPTION
    const farewellInstruction = config.farewellInstruction ?? DEFAULT_INSTRUCTION

    ctx.effect(
      () =>
        ctx.tools.register({
          name: toolName,
          description,
          parameters: { type: "object", properties: {} },
          execute: async (_arguments: unknown, context: ToolExecutionContext) => {
            // requestClose 会等到当前 Turn 结束才真正关闭，所以这里不能 await（会死锁）。
            void this.session.requestClose(context.sessionId).catch((error: unknown) => {
              this.ctx.logger("session-control").warn("关闭会话失败：%o", error)
            })
            return farewellInstruction
          },
        }),
      "sessionControl.registerCloseTool",
    )
  }
}

export default SessionControl
