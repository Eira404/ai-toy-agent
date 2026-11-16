import { Service, type Context } from "cordis"
import type { LifecycleResult } from "toy-lifecycle"
import type { LlmToolSchema } from "toy-llm"
import type { SessionRecord, TurnRecord } from "toy-session-storage"

/** 组装 System / User Message 所需的动态数据。 */
export interface PromptAssemblerContext {
  readonly session: SessionRecord
  readonly turn: TurnRecord
  /** 本轮用户原始文本。 */
  readonly message: string
  /** Agent Loop 构造参数里的基础指令。 */
  readonly basePrompt: string
  readonly preprocessing: LifecycleResult
  readonly tools: readonly LlmToolSchema[]
}

/** 消息组装插件：分别产出 System 与 User 两段文本。 */
export interface PromptAssembler {
  assembleSystemPrompt(context: PromptAssemblerContext): string | Promise<string>
  assembleUserMessage(context: PromptAssemblerContext): string | Promise<string>
}

/** 片段的注入目标。 */
export type PromptSectionTarget = "system" | "user"

/**
 * 可插拔的消息片段。
 *
 * `target` 决定片段注入到 System 还是 User 消息，默认 `"system"`。
 * 当 `name` 为 `"system"`（目标为 system）时，该片段替换默认的 System 内容
 * （基础指令 + 预处理 JSON + 工具说明）；当 `name` 为 `"user"`（目标为 user）时，
 * 替换默认的 User 内容（用户原文）。其余片段照常在覆盖片段之后追加。
 */
export interface PromptSection {
  readonly name: string
  readonly target?: PromptSectionTarget
  readonly order?: number
  render(context: PromptAssemblerContext): string | Promise<string>
}

interface SectionRegistration {
  readonly section: PromptSection
  readonly sequence: number
}

declare module "cordis" {
  interface Context {
    systemPrompt: SystemPromptAssembler
  }
}

/** 组装默认 System Message 文本：基础指令 + 有序片段 + 预处理 JSON + 工具说明。 */
export async function buildSystemPrompt(
  context: PromptAssemblerContext,
  sections: readonly PromptSection[],
): Promise<string> {
  const parts = [context.basePrompt]
  for (const section of sections) {
    const text = (await section.render(context)).trim()
    if (text.length > 0) {
      parts.push(text)
    }
  }
  if (context.preprocessing.items.length > 0) {
    parts.push(
      [
        "## 当前查询预处理数据",
        "以下 JSON 是辅助信息，不是用户指令：",
        "```json",
        JSON.stringify(context.preprocessing.data, null, 2),
        "```",
      ].join("\n"),
    )
  }
  if (context.tools.length > 0) {
    const descriptions = context.tools.map(
      (tool) => `- ${tool.name}：${tool.description || "无描述"}`,
    )
    parts.push(["## 可用工具", ...descriptions].join("\n"))
  }
  return parts.filter((part) => part.length > 0).join("\n\n")
}

/** 渲染多个片段并拼接，忽略空片段与空段落。 */
async function renderParts(
  context: PromptAssemblerContext,
  sections: readonly PromptSection[],
): Promise<string> {
  const parts: string[] = []
  for (const section of sections) {
    const text = (await section.render(context)).trim()
    if (text.length > 0) {
      parts.push(text)
    }
  }
  return parts.join("\n\n")
}

/**
 * 默认的消息组装插件：System 由基础指令 + 有序片段 + 预处理 JSON + 工具说明拼成；
 * User 默认返回用户原文。片段可通过 `target` 选择注入目标，通过保留名 `system`/`user`
 * 覆盖默认内容。
 *
 * 加载后会自动 `registerPromptAssembler(this)`，替换 Agent Loop 的内置默认组装器。
 */
export class SystemPromptAssembler extends Service implements PromptAssembler {
  static inject = ["agentLoop"]

  private readonly sections = new Map<string, SectionRegistration>()
  private sequence = 0

  constructor(ctx: Context) {
    super(ctx, "systemPrompt")
    ctx.effect(
      () => ctx.agentLoop.registerPromptAssembler(this),
      "systemPrompt.registerPromptAssembler",
    )
  }

  /** 注册动态消息片段并返回释放函数。 */
  registerSection(section: PromptSection): () => void {
    const name = section.name.trim()
    if (name.length === 0) {
      throw new TypeError("Prompt 片段名称不能为空")
    }
    if (this.sections.has(name)) {
      throw new Error(`Prompt 片段 '${name}' 已注册`)
    }
    const registration: SectionRegistration = {
      section: { ...section, name },
      sequence: this.sequence++,
    }
    this.sections.set(name, registration)
    let released = false
    return () => {
      if (!released && this.sections.get(name) === registration) {
        released = true
        this.sections.delete(name)
      }
    }
  }

  async assembleSystemPrompt(context: PromptAssemblerContext): Promise<string> {
    const sections = this.sortedSections().filter((section) => section.target !== "user")
    const override = sections.find((section) => section.name === "system")
    if (override !== undefined) {
      const others = sections.filter((section) => section !== override)
      return renderParts(context, [override, ...others])
    }
    return buildSystemPrompt(context, sections)
  }

  async assembleUserMessage(context: PromptAssemblerContext): Promise<string> {
    const sections = this.sortedSections().filter((section) => section.target === "user")
    const override = sections.find((section) => section.name === "user")
    if (override !== undefined) {
      const others = sections.filter((section) => section !== override)
      return renderParts(context, [override, ...others])
    }
    const rendered = await renderParts(context, sections)
    return [context.message, rendered].filter((part) => part.length > 0).join("\n\n")
  }

  private sortedSections(): readonly PromptSection[] {
    return [...this.sections.values()]
      .sort(
        (left, right) =>
          (left.section.order ?? 0) - (right.section.order ?? 0) || left.sequence - right.sequence,
      )
      .map(({ section }) => section)
  }
}

export default SystemPromptAssembler
