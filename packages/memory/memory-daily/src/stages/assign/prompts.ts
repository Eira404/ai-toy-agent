import type { LongBlock } from "toy-memory-long"
import type { LongCandidate } from "../consolidate-cross/types.js"

export const STAGE_3_TARGET_SYSTEM_MESSAGE = `
判断候选应该更新哪个已有块，还是创建新块。
内容相关、标题相同或别名相同都不能单独证明应更新已有块；
身份或主题边界无法确认时必须创建新块，不能污染已有块。
只能选择一个已有块或选择创建新块，不能合并多个块、修改 Domain 或生成新正文。
`.trim()

export function buildTargetUserMessage(
  candidate: LongCandidate,
  domain: string,
  blocks: readonly LongBlock[],
): string {
  const blocksStr = blocks
    .map((block) => {
      const detailsStr = block.details
        .map((detail) => `  DetailId:${detail.detailId}\n  Summary:${detail.summary}\n  Body:${detail.body}`)
        .join("\n")
      return (
        `BlockId:${block.blockId}\nDomain:${block.domain}\nTitle:${block.title}\n` +
        `Aliases:${block.aliases.join(", ")}\nSummary:${block.summary}\n` +
        `OverviewBody:${block.overviewBody}\nDetails:\n${detailsStr}`
      )
    })
    .join("\n---\n")
  return (
    `候选：\nTitle:${candidate.title}\nSummary:${candidate.summary}\nBody:${candidate.body}\n\n` +
    `候选 Domain:${domain}\n\n相关块：\n${blocksStr}`
  )
}
