import type { ValueState } from "toy-memory-long"

/**
 * 阶段零输出（checkpoint stage 1）：每个被检索价值单元巩固后的价值。
 *
 * `reinforced` 的键是 `unitKey`（`overview:{blockId}` / `detail:{detailId}`），
 * 值为该单元从冻结原值出发、施加本批反馈后的强化结果（R0）。无价值引擎时为空。
 */
export interface ConsolidationResult {
  readonly reinforced: Readonly<Record<string, ValueState>>
  /** 反馈引用了、但冻结 Long 中不存在（已归档/删除）的单元键，供运维。 */
  readonly skipped: readonly string[]
}
