import type { LongBlock } from "toy-memory-long"
import type { BlockChangePlan } from "../generate/types.js"
import type { VerifyIssueType } from "./schema.js"

export const STAGE_6_VERIFY_SYSTEM_MESSAGE = `
独立验证一个记忆块的变化方案。对比「来源候选」和「最终模拟块」，判断是否存在问题：
- CONTRADICTED：最终事实与有效来源冲突。
- UNSUPPORTED：最终事实没有来源依据。
- MISSING：仍有效且应保留的来源事实没有最终去向。
- DUPLICATED：同一事实被放入多个主要位置。
- MISPLACED：事实正确，但概括与细节的位置不合理。
- INVALID_ALIAS：别名没有明确指向证据或已被新证据否认。
- MISLEADING_TITLE：标题无法准确表示当前块。
- MISLEADING_SUMMARY：块或细节摘要与实际正文不一致。
没有问题时返回 PASS；有问题时列出每个问题的类型、字段、片段、依据和建议动作。
`.trim()

export const STAGE_6_REPAIR_SYSTEM_MESSAGE = `
根据验证问题与建议，重新生成完整的记忆块。
必须保持 Domain 和目标块不变，不能补充来源之外的事实，不能输出价值数值。
可以重新生成 title/aliases/summary/概述，也可以更新或删除细节；未列出的旧细节保持不变。
`.trim()

function formatCandidates(plan: BlockChangePlan): string {
  return plan.candidates
    .map(
      (candidate) =>
        `Time:${candidate.candidateTime}\nTitle:${candidate.title}\nSummary:${candidate.summary}\nBody:${candidate.body}`,
    )
    .join("\n---\n")
}

function formatPlan(plan: BlockChangePlan): string {
  const detailOps = plan.detailOps
    .map((op) =>
      op.kind === "UPDATE"
        ? `UPDATE ${op.detailId}: ${op.summary} | ${op.body}`
        : op.kind === "DELETE"
          ? `DELETE ${op.detailId}`
          : `CREATE: ${op.summary} | ${op.body}`,
    )
    .join("\n")
  return (
    `Domain:${plan.domain}\nTitle:${plan.title}\nAliases:${plan.aliases.join(", ")}\n` +
    `Summary:${plan.summary}\nOverviewBody:${plan.overviewBody}${
    detailOps === "" ? "" : `\n细节操作：\n${detailOps}`}`
  )
}

function formatOldBlock(block: LongBlock | null): string {
  if (block === null) {
    return "（新建目标，无旧块）"
  }
  const details = block.details
    .map((detail) => `DetailId:${detail.detailId}\nSummary:${detail.summary}\nBody:${detail.body}`)
    .join("\n---\n")
  return (
    `Domain:${block.domain}\nTitle:${block.title}\nAliases:${block.aliases.join(", ")}\n` +
    `Summary:${block.summary}\nOverviewBody:${block.overviewBody}\nDetails:\n${details}`
  )
}

export function buildVerifyUserMessage(
  plan: BlockChangePlan,
  oldBlock: LongBlock | null,
  truncatedFields: readonly string[],
): string {
  return (
    `旧块：\n${formatOldBlock(oldBlock)}\n\n来源候选：\n${formatCandidates(plan)}\n\n` +
    `最终模拟块：\n${formatPlan(plan)}\n\n裁切字段：${truncatedFields.join(", ") || "（无）"}`
  )
}

export function buildRepairUserMessage(
  plan: BlockChangePlan,
  oldBlock: LongBlock | null,
  issues: readonly { type: VerifyIssueType; field: string; snippet: string; evidence: string; suggestion: string }[],
): string {
  const issuesStr = issues
    .map(
      (issue) =>
        `- ${issue.type} @ ${issue.field}\n  片段：${issue.snippet}\n  依据：${issue.evidence}\n  建议：${issue.suggestion}`,
    )
    .join("\n")
  return (
    `旧块：\n${formatOldBlock(oldBlock)}\n\n来源候选：\n${formatCandidates(plan)}\n\n` +
    `当前失败块：\n${formatPlan(plan)}\n\n验证问题：\n${issuesStr}`
  )
}
