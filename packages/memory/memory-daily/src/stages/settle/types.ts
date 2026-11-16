import type { LifecycleStatus, ValueState } from "toy-memory-long"
import type { BlockChangePlan } from "../generate/types.js"

/** 一个 APPLY 块的概述价值 + 生命周期，以及每个非 DELETE 细节的结算。 */
export interface SettledBlock {
  readonly plan: BlockChangePlan
  readonly overviewValue: ValueState
  readonly overviewLifecycle: LifecycleStatus
  /** 按 plan.detailOps 顺序（跳过 DELETE）的细节结算值。 */
  readonly detailValues: readonly { value: ValueState; lifecycle: LifecycleStatus }[]
}

/** 阶段七输出（checkpoint stage 8）。 */
export interface SettlementResult {
  readonly settled: readonly SettledBlock[]
  readonly abandoned: readonly BlockChangePlan[]
}
