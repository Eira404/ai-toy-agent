import type { BlockChangePlan } from "../generate/types.js"

export type VerifyVerdict = "APPLY" | "LOCAL_ABANDON"

/**
 * 阶段六输出（checkpoint stage 7）：每个目标块的验证结果。
 *
 * - APPLY：通过验证（或修正后通过）的最终变化方案；
 * - LOCAL_ABANDON：修正两轮仍失败的方案（已有块恢复旧内容、新块取消），
 *   `plan` 保留原方案供阶段八审计。
 */
export interface VerifyOutcome {
  readonly verdict: VerifyVerdict
  readonly plan: BlockChangePlan
}
