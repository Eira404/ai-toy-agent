/** 价值单元类型：块概述或细节。 */
export type WeeklyUnitType = "overview" | "detail"

/**
 * 构造价值单元的稳定键：`overview:{blockId}` 或 `detail:{detailId}`。
 *
 * 价值迁移阶段用该键在「冻结旧 Long」与「最终快照」之间对齐价值来源，不落库。
 */
export function unitKey(unitType: WeeklyUnitType, unitId: string): string {
  return `${unitType}:${unitId}`
}
