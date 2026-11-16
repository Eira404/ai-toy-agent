import type { LongDomain } from "toy-memory-long"
import { WeeklyMemoryError } from "../../error.js"
import type { WeeklySnapshotBlock } from "../../snapshot.js"
import type { WeeklyStageEnv } from "../../stage.js"
import { DOMAIN_CRITERIA, LONG_DOMAINS } from "./domain.js"

/** 第一问的 choice 判据。 */
const KEEP_OR_MISCLASSIFIED: Readonly<Record<string, string>> = {
  KEEP_CURRENT: "当前 Domain 合理；或只是可能更合适、证据不足、存在歧义",
  CLEARLY_MISCLASSIFIED: "当前 Domain 明显违反其定义",
}

const NO_CLEAR_TARGET = "无法唯一确定目标 Domain，保持原 Domain"

/**
 * 阶段二：RECLASSIFY —— 只把「当前 Domain 明显错误」的块移到唯一清晰的目标 Domain。
 *
 * 只处理修改集中的块；不拆分、不合并、不改正文、不改价值。无 JEV 时整体跳过（保持原 Domain）。
 * 任一 JEV 调用失败直接抛出，由上层按 `weeklyStageMaxAttempts` 阶段内重试。
 */
export async function runReclassify(
  env: WeeklyStageEnv,
  snapshot: readonly WeeklySnapshotBlock[],
  modifiedBlockIds: readonly string[],
): Promise<WeeklySnapshotBlock[]> {
  if (!hasJev(env)) {
    return [...snapshot]
  }
  const modifiedSet = new Set(modifiedBlockIds)
  const result: WeeklySnapshotBlock[] = []
  for (const block of snapshot) {
    result.push(modifiedSet.has(block.blockId) ? await reclassifyBlock(env, block) : block)
  }
  return result
}

/** 对一个块做双重 JEV 判断；通过才改 Domain，否则原样返回。 */
async function reclassifyBlock(env: WeeklyStageEnv, block: WeeklySnapshotBlock): Promise<WeeklySnapshotBlock> {
  // TODO: 完整块超过 JEV 输入容量时保持原 Domain 并记 RECLASSIFY_SKIPPED_TOO_LARGE。
  const state = buildBlockState(block)

  // 第一问：KEEP_CURRENT / CLEARLY_MISCLASSIFIED
  const first = await env.ctx.jev.invoke(
    state,
    {
      reclassify: {
        type: "choice",
        instructions: `判断该块当前 Domain（${block.domain}）是否明显不再符合其定义。`,
        criteria: KEEP_OR_MISCLASSIFIED,
      },
    },
    { provider: env.config.jevProvider },
  )
  const firstAnswer = first.answers.reclassify
  if (firstAnswer?.type !== "choice") {
    throw new WeeklyMemoryError("invalid-input", "JEV 返回了非法的 reclassify 判断")
  }
  if (firstAnswer.choice === "KEEP_CURRENT") {
    return block
  }
  if (firstAnswer.choice !== "CLEARLY_MISCLASSIFIED") {
    throw new WeeklyMemoryError("invalid-input", `JEV 返回了未知选项 '${firstAnswer.choice}'`)
  }

  // 第二问：从其它 Domain 或 NO_CLEAR_TARGET 中选一个
  const criteria: Record<string, string> = {}
  for (const domain of LONG_DOMAINS) {
    if (domain !== block.domain) {
      criteria[domain] = DOMAIN_CRITERIA[domain]
    }
  }
  criteria["NO_CLEAR_TARGET"] = NO_CLEAR_TARGET

  const second = await env.ctx.jev.invoke(
    state,
    {
      target: {
        type: "choice",
        instructions: "选择更合适的目标 Domain，无法唯一确定时选 NO_CLEAR_TARGET。",
        criteria,
      },
    },
    { provider: env.config.jevProvider },
  )
  const secondAnswer = second.answers.target
  if (secondAnswer?.type !== "choice") {
    throw new WeeklyMemoryError("invalid-input", "JEV 返回了非法的 target 判断")
  }
  if (secondAnswer.choice === "NO_CLEAR_TARGET") {
    return block
  }
  if (!LONG_DOMAINS.includes(secondAnswer.choice as LongDomain) || secondAnswer.choice === block.domain) {
    throw new WeeklyMemoryError("invalid-input", `JEV 返回了非法目标 Domain '${secondAnswer.choice}'`)
  }

  return {
    ...block,
    domain: secondAnswer.choice as LongDomain,
    ops: [...block.ops, "RECLASSIFY"],
  }
}

function hasJev(env: WeeklyStageEnv): boolean {
  return env.config.jevProvider.trim().length > 0
}

/** 把块内容拼成 JEV 评估用的纯文本 state。 */
function buildBlockState(block: WeeklySnapshotBlock): string {
  const details = block.details
    .map((detail) => `DetailId:${detail.detailId}\nDetailSummary:${detail.summary}\nDetailBody:${detail.body}`)
    .join("\n---\n")
  const lines = [
    `Domain:${block.domain}`,
    `Title:${block.title}`,
    `Aliases:${block.aliases.join(", ")}`,
    `Summary:${block.summary}`,
    `Body:${block.overviewBody}`,
  ]
  if (details.length > 0) {
    lines.push(`Details:\n${details}`)
  }
  return lines.join("\n")
}
