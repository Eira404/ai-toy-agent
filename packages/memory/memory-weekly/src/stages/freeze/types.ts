import type { LongBlock } from "toy-memory-long"
import type { WeeklySnapshotBlock } from "../../snapshot.js"

/**
 * 冻结基线（checkpoint stage 0）：前置 Daily 后的最新 Long 快照 + 需要重查结构的修改集。
 */
export interface WeeklyFreezeBaseline {
  /** 当前 active + observing 的 Long 快照（含价值状态与 contentUpdatedAt），供 migrate-value / commit 读旧值。 */
  readonly frozenLong: readonly LongBlock[]
  /** 可变快照（结构阶段的连续工作态），供 split/reclassify/merge/rename 变换。 */
  readonly snapshot: readonly WeeklySnapshotBlock[]
  /** `contentUpdatedAt > lastWeeklyAt` 的块；`lastWeeklyAt` 为 null 时为全部。 */
  readonly modifiedBlockIds: readonly string[]
  /** 上次成功 Weekly 时间（来自 daily space_state）；首次为 null。 */
  readonly lastWeeklyAt: string | null
}
