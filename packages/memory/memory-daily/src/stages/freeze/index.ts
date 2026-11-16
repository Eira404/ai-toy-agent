import type { StageEnv } from "../../stage.js"
import type { FreezeBaseline } from "./types.js"

/**
 * 冻结：读取本批待处理的 Fast、反馈与当前 Long 快照，形成冻结基线。
 *
 * 假设调用时 Gate 已 LOCKED（无进行中 Session），因此读到的即本次可处理的全部输入。
 */
export async function runFreeze(env: StageEnv): Promise<FreezeBaseline> {
  const [fastRecords, frozenLong, frozenFeedback] = await Promise.all([
    env.fast.listPendingForDaily(env.scope),
    env.long.freezeSnapshot(env.scope),
    env.feedback.listPending(env.scope),
  ])

  return {
    fastRecords,
    sessionIds: [...new Set(fastRecords.map((record) => record.sessionId))],
    turnCount: 0, // TODO: 活动阈值暂不统计
    frozenLong,
    frozenFeedback,
    decayEnabled: true, // TODO: 活动阈值暂不判断，暂恒 true
  }
}
