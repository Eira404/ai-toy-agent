import type { FastRecord } from "toy-memory-fast"
import type { ConversationItem } from "./types.js"

/**
 * Fast 提取提示词，迁自 v1 的 `fast-mem-extractor/prompts.ts`，
 * 并按 v2 方案把 `facts` 改为 `body`（Markdown 无序列表）。
 */

export const FAST_EXTRACT_SYSTEM_MESSAGE = `
你是记忆提取器。只提取用户本轮新表达、值得跨轮保留且有明确依据的信息。

规则：
- 当前用户输入是本轮新增事实的主要来源；历史用户消息和已有 Fast 只用于补全指代、识别重复、补充、状态变化或纠错。
- Agent 消息只能帮助理解语境，不能单独成为事实；不能使用输入证据之外的常识补造。
- 补充、状态变化或纠错生成新的记忆，不修改旧记忆；新记忆要自包含地表达本轮之后的有效结论，必要时说明是状态变化还是明确纠错。
- 同一对象或紧密主题的事实放在同一条 memory；不同对象或独立主题才拆分，禁止为拆分而拆分。
- 人际关系与身份信息（例如"小明是我的好朋友""我妈妈是医生"）值得独立保存，即使它只是铺垫其他话题的语境。
- 用户的话可能很短（例如"对对，阳光玫瑰""其实是三文鱼"），是对上文的确认、纠正或补充：必须结合最近对话补全语境，写成完整自包含的表述。
- 当前有效且会影响后续回答的临时状态或限制允许保存，不能仅因可能短期有效而丢弃。
- 无法可靠确定人物、对象或指代时，不要强行选择；用户明确要求记住时，也只保存能准确表达的部分。
- 不普遍记录"用户没有提及某字段"。
- 没有新增价值的完全重复、普通寒暄和无关内容输出空数组。
- 输出语言跟随当前用户输入的主要语言。

每条 memory 包含三个字段：
- title：具体、稳定、简短的对象或子主题名称，不写完整事实句。
- summary：包含核心人物/对象、关键动作或关系、当前有效结论的检索摘要。
- body：完整自包含事实，使用 Markdown 无序列表，每一项都明确主语、对象和事实，不依赖脱离上下文的指代。

只返回 Schema 要求的字段；没有可安全保存的信息时返回 {"memories":[]}。
`.trim()

/**
 * 构造提取的用户消息：当前输入 + 近期对话 + 近期 Fast，三段式标签。
 *
 * @param userMessage 当前用户原话。
 * @param recentConversation 近期有序对话。
 * @param recentFast 同 Session 最近的有效 Fast。
 */
export function buildUserMessage(
  userMessage: string,
  recentConversation: readonly ConversationItem[],
  recentFast: readonly FastRecord[],
): string {
  const conversationStr = recentConversation
    .map((item) => `Role:${item.role}\nContent:${item.content}`)
    .join("\n")
  const fastStr = recentFast
    .map((record) => `Title:${record.title}\nSummary:${record.summary}\nBody:${record.body}`)
    .join("\n")
  return [
    "<USER_INPUT>",
    userMessage,
    "</USER_INPUT>",
    "",
    "<RECENT_CONVERSATION>",
    conversationStr,
    "</RECENT_CONVERSATION>",
    "",
    "<RECENT_FAST_MEMORY>",
    fastStr,
    "</RECENT_FAST_MEMORY>",
  ].join("\n")
}
