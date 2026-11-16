import type { ParsedQueryAnalysisInput } from "./contracts.js"
import { PRIMARY_DOMAIN_CATALOG } from "./domain-catalog.js"

export function createSystemPrompt(hasHistory: boolean): string {
  const catalog = PRIMARY_DOMAIN_CATALOG.map(
    (domain) => `- $${domain.name}：${domain.description}`,
  ).join("\n")

  const rewriteInstruction = hasHistory
    ? [
        "结合历史消息理解当前 Query 中的代词指向。",
        "rewrittenQuery 只允许把代词替换成历史中明确出现的指代对象。",
        "不得改写问法、语序、语气、约束、事实、标点或其他非代词内容。",
        "没有代词、指代不明确或证据不足时，rewrittenQuery 必须逐字保持当前 Query。",
      ]
    : ["当前没有历史消息，rewrittenQuery 必须逐字保持当前 Query，只判断领域。"]

  return [
    "你是 Query 分析模块。不要回答 Query。",
    ...rewriteInstruction,
    "必须选择一个 primaryDomain。",
    "secondaryDomains 只有在 Query 确实涉及不同一级领域时才填写，绝大多数情况应为空数组。",
    "副领域不能与主领域相同，也不能包含“其他”，不要为了覆盖相关概念而过度添加副领域。",
    "当多个领域内容量和相关性相近时，把 Query 中最先出现的领域作为主领域。",
    "“其他”只用于已经理解 Query、但确实无法归入其余领域的情况。",
    "你会在<HISTORY></HISTORY>中收到上下文历史，在<QUERY></QUERY>中收到需要改写和判断的用户query。",
    "",
    "一级领域目录：",
    catalog,
  ].join("\n")
}

export function createUserMessage(input: ParsedQueryAnalysisInput) {
  const query = input.query
  const history = input.history.map((h) => `Role:${h.role}\nContent:${h.content}`).join("\n---\n")
  return `<HISTORY>\n${history}\n</HISTORY>\n\n<QUERY>\n${query}\n</QUERY>`
}
