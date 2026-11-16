import type { LongBlock } from "toy-memory-long"
import type { LongCandidate } from "../consolidate-cross/types.js"

export const STAGE_4_CREATE_SYSTEM_MESSAGE = `
根据候选信息生成一个新的记忆块。记忆块应准确、完整地保存与当前对象或子主题有关的核心事实，使其能够独立用于后续检索、理解和回答。

- **title**：具体、稳定、简短的对象或子主题名称，不写完整事实句。优先使用明确的实体名称或主题名称，避免宽泛、临时性的标题。
- **aliases**：保守提取。只有候选证据明确表明某个名称、简称或称呼指向当前记忆块时才新增，不推测别名。
- **summary**：用于路由和检索的简短摘要，说明记忆块涉及的对象、主题及主要信息范围。重点是帮助判断是否需要检索此块，不代替事实正文。
- **overviewBody**：保存当前有效的核心事实及其必要上下文，要求：
  1. **具体完整**：尽可能保留有明确证据的人物、时间、地点、事件、对象、关系、数量、参数、原因、结果等关键信息，不得为了简短而丢失影响事实理解的细节。
  2. **准确表达**：明确事实的主体、行为、对象及其关系，消除可以依据上下文确定的模糊指代，使信息脱离原始对话仍可独立理解。
  3. **保留时间与状态**：区分当前状态、历史变化、未来计划及尚未确认的事项。存在明确时间时应尽量保留，不能将过去的事实或未来的计划直接表述为当前事实。
  4. **保留重要限定**：对于偏好、要求、决定、观点等信息，保留其适用对象、条件、原因及限制，避免将特定情境下的表达泛化成永久特征。
  5. **优先当前信息**：优先保存最新且有效的事实；历史信息仅在有助于理解当前状态、变化过程或重要决策时保留。
  6. **保持信息密度**：使用清晰、自然、紧凑的事实性语言。允许包含多个相关事实，不强制压缩为一句话，也不增加重复、空泛的总结。
  7. **忠于证据**：不推测候选中未提供的信息；存在冲突或不确定性时，保留必要的时间、来源或不确定性说明，不擅自合并为确定结论。
- **细节操作**：不生成细节操作，新记忆块不创建细节。

整体要求：优先保证事实的准确性、完整性和独立可理解性，再考虑简洁性。记忆应保存可被未来直接利用的具体信息，而非对候选内容进行笼统总结。
`.trim()

export const STAGE_4_UPDATE_SYSTEM_MESSAGE = `
根据候选和旧块，完整重新生成更新后的记忆块。
- title/aliases/summary/overviewBody：完整生成，允许参考旧内容重新组织表达。
- 细节操作：
  - UPDATE(detailId, summary, body)：候选直接补充、更新或纠正已有细节时，重新生成该细节完整内容。
  - DELETE(detailId)：仅当用户明确表示从未说过该内容或该记忆不属于自己时使用。
- 普通事实纠错、状态变化、局部错误和补充都必须用 UPDATE，不能 DELETE。
- 未出现在操作列表里的旧细节由程序原文保留。
- aliases 保守：旧别名默认保留，只有候选证据明确支持才新增，只有明确否认才移除。
- 不输出价值数值、不修改 Domain。
`.trim()

function buildCandidatesStr(candidates: readonly LongCandidate[]): string {
  return candidates
    .map(
      (candidate) =>
        `Time:${candidate.candidateTime}\nTitle:${candidate.title}\nSummary:${candidate.summary}\nBody:${candidate.body}`,
    )
    .join("\n---\n")
}

export function buildCreateUserMessage(
  candidates: readonly LongCandidate[],
  domain: string,
): string {
  return `Domain:${domain}\n\n候选：\n${buildCandidatesStr(candidates)}`
}

export function buildUpdateUserMessage(
  candidates: readonly LongCandidate[],
  block: LongBlock,
): string {
  const detailsStr = block.details
    .map((detail) => `DetailId:${detail.detailId}\nSummary:${detail.summary}\nBody:${detail.body}`)
    .join("\n---\n")
  return (
    `Domain:${block.domain}\n\n旧块：\nTitle:${block.title}\nAliases:${block.aliases.join(", ")}\n` +
    `Summary:${block.summary}\nOverviewBody:${block.overviewBody}\n\n旧细节：\n${detailsStr}\n\n` +
    `候选：\n${buildCandidatesStr(candidates)}`
  )
}
