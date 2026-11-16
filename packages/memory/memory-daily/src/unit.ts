import type { ValueUnitType } from "toy-memory-feedback"

/**
 * 构造价值单元的稳定键：`overview:{blockId}` 或 `detail:{detailId}`。
 *
 * 阶段零（巩固）与阶段七（结算）共用同一键格式，用于在 checkpoint 之间
 * 按单元索引价值。
 */
export function unitKey(unitType: ValueUnitType, unitId: string): string {
  return `${unitType}:${unitId}`
}
