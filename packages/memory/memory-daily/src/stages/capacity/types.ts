import type { BlockChangePlan } from "../generate/types.js"

/**
 * 阶段五输出（checkpoint stage 6）：容量整理后的变化方案 + 裁切标记。
 *
 * `truncatedFields` 记录被程序兜底裁切的字段标识（如 `title`、`overviewBody`、
 * `detail:{detailId}.body`），供阶段六忽略由裁切导致的 MISSING 问题。
 */
export interface CapacityOutcome {
  readonly plan: BlockChangePlan
  readonly truncatedFields: readonly string[]
}
