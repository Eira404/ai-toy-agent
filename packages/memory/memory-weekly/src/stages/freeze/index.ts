import { buildSnapshot } from "../../snapshot.js"
import type { WeeklyStageEnv } from "../../stage.js"
import type { WeeklyFreezeBaseline } from "./types.js"

/**
 * 冻结：读取前置 Daily 刚提交的最新 Long，转成可变快照，并按 `contentUpdatedAt > lastWeeklyAt` 计算修改集。
 *
 * 假设调用时 Gate 已 LOCKED，因此读到的即本次可处理的全部 Long。
 */
export async function runFreeze(
  env: WeeklyStageEnv,
  lastWeeklyAt: string | null,
): Promise<WeeklyFreezeBaseline> {
  const frozenLong = await env.long.freezeSnapshot(env.scope)
  const snapshot = buildSnapshot(frozenLong)
  const modifiedBlockIds = frozenLong
    .filter((block) => lastWeeklyAt === null || block.contentUpdatedAt > lastWeeklyAt)
    .map((block) => block.blockId)
  return { frozenLong, snapshot, modifiedBlockIds, lastWeeklyAt }
}
