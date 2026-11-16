import { RelationalError } from "./error.js"
import type { RelationalTableDefinition } from "./schema.js"

/** 跨数据库统一使用的升序和降序方向。 */
export type RelationalOrderDirection = "asc" | "desc"

/** 一个字段的排序声明；数组中的位置决定多字段排序优先级。 */
export interface RelationalOrderBy {
  readonly field: string
  readonly direction: RelationalOrderDirection
}

/**
 * 校验排序字段存在且没有重复。
 *
 * @param tableName 排序作用的逻辑表名。
 * @param table 该表的字段定义。
 * @param ordering 按优先级排列的排序字段列表。
 * @returns 所有排序项合法时无返回值。
 * @throws {RelationalError} 排序引用未知字段或重复字段时抛出。
 */
export function assertRelationalOrdering(
  tableName: string,
  table: RelationalTableDefinition,
  ordering: readonly RelationalOrderBy[],
): void {
  // 同一字段重复排序没有明确意义，也可能被不同数据库做不同解释。
  const fields = new Set<string>()
  for (const order of ordering) {
    if (table.columns[order.field] === undefined) {
      throw new RelationalError("invalid-field", `表 '${tableName}' 不存在字段 '${order.field}'`)
    }
    if (fields.has(order.field)) {
      throw new RelationalError(
        "invalid-operation",
        `表 '${tableName}' 的排序重复使用字段 '${order.field}'`,
      )
    }
    fields.add(order.field)
  }
}
