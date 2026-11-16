import type { FastRecord } from "toy-memory-fast"
import type { LongBlock } from "toy-memory-long"
import type { FeedbackOutcome } from "toy-memory-feedback"

/**
 * 冻结基线（checkpoint stage 0）：一次 Daily 批次要处理的全部输入快照。
 *
 * - `fastRecords` / `sessionIds`：待处理 Fast 全文及其来源 Session（去重）；
 * - `turnCount`：可处理 Turn 数（活动阈值暂不判断，固定 0）；
 * - `frozenLong`：当前 active + observing 的 Long 快照；
 * - `frozenFeedback`：待巩固的反馈；
 * - `decayEnabled`：是否推进一个衰减周期（活动阈值暂不判断，固定 true）。
 */
export interface FreezeBaseline {
  readonly fastRecords: readonly FastRecord[]
  readonly sessionIds: readonly string[]
  readonly turnCount: number
  readonly frozenLong: readonly LongBlock[]
  readonly frozenFeedback: readonly FeedbackOutcome[]
  readonly decayEnabled: boolean
}
