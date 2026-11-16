import { RelationalError } from "./error.js"
import type { JsonValue } from "./json.js"
import { assertColumnValue, type RelationalTableDefinition } from "./schema.js"

/** 标量值的比较运算符，分别表示等于、不等于、大于、大于等于、小于、小于等于。 */
export type RelationalComparisonType = "eq" | "ne" | "gt" | "gte" | "lt" | "lte"

/** 单字段与单个值的比较条件。 */
export interface RelationalComparisonFilter {
  readonly type: RelationalComparisonType
  readonly field: string
  readonly value: JsonValue
}

/** 单字段对一组值执行 in 或 notIn 的条件。 */
export interface RelationalSetFilter {
  readonly type: "in" | "notIn"
  readonly field: string
  readonly values: readonly JsonValue[]
}

/** 判断字段是否为 null 的条件。 */
export interface RelationalNullFilter {
  readonly type: "isNull" | "isNotNull"
  readonly field: string
}

/** 字符串字段的 SQL LIKE 风格模式条件。 */
export interface RelationalLikeFilter {
  readonly type: "like"
  readonly field: string
  readonly pattern: string
}

/** 使用 and 或 or 组合多个子条件。 */
export interface RelationalJunctionFilter {
  readonly type: "and" | "or"
  readonly conditions: readonly RelationalFilter[]
}

/** 对一个子条件取反。 */
export interface RelationalNotFilter {
  readonly type: "not"
  readonly condition: RelationalFilter
}

/** adapter 和内存实现共同支持的条件表达式树。 */
export type RelationalFilter =
  | RelationalComparisonFilter
  | RelationalSetFilter
  | RelationalNullFilter
  | RelationalLikeFilter
  | RelationalJunctionFilter
  | RelationalNotFilter

/**
 * 校验条件树中的字段、值、运算符组合和递归深度。
 *
 * @param tableName 条件作用的逻辑表名。
 * @param table 该表的字段定义。
 * @param filter 待校验的条件表达式树。
 * @returns 整棵条件树合法时无返回值。
 * @throws {RelationalError} 字段、值、运算符组合或深度不合法时抛出。
 */
export function assertRelationalFilter(
  tableName: string,
  table: RelationalTableDefinition,
  filter: RelationalFilter,
): void {
  // 从零开始记录深度，避免恶意或错误输入造成无限递归和栈溢出。
  visitFilter(tableName, table, filter, 0)
}

/**
 * 递归访问条件树并验证每个叶子条件。
 *
 * @param tableName 条件所属表名。
 * @param table 表字段定义。
 * @param filter 当前递归节点。
 * @param depth 当前嵌套深度。
 * @returns 当前节点及全部后代合法时无返回值。
 */
function visitFilter(
  tableName: string,
  table: RelationalTableDefinition,
  filter: RelationalFilter,
  depth: number,
): void {
  if (depth > 32) {
    throw new RelationalError("invalid-operation", "条件表达式嵌套不能超过 32 层")
  }

  switch (filter.type) {
    case "eq":
    case "ne":
    case "gt":
    case "gte":
    case "lt":
    case "lte": {
      const column = requireFilterColumn(tableName, table, filter.field)
      assertColumnValue(tableName, filter.field, column, filter.value)
      return
    }
    case "in":
    case "notIn": {
      const column = requireFilterColumn(tableName, table, filter.field)
      for (const value of filter.values) {
        assertColumnValue(tableName, filter.field, column, value)
      }
      return
    }
    case "isNull":
    case "isNotNull": {
      requireFilterColumn(tableName, table, filter.field)
      return
    }
    case "like": {
      const column = requireFilterColumn(tableName, table, filter.field)
      if (column.type !== "string") {
        throw new RelationalError(
          "invalid-operation",
          `表 '${tableName}' 只有 string 字段可以使用 like，'${filter.field}' 不是 string`,
        )
      }
      return
    }
    case "and":
    case "or": {
      if (filter.conditions.length === 0) {
        throw new RelationalError("invalid-operation", `${filter.type} 条件不能为空`)
      }
      for (const condition of filter.conditions) {
        // 每进入一个组合节点就增加深度，统一执行最大深度保护。
        visitFilter(tableName, table, condition, depth + 1)
      }
      return
    }
    case "not":
      visitFilter(tableName, table, filter.condition, depth + 1)
  }
}

/**
 * 获取条件引用的字段定义，并把未知字段转换为稳定错误。
 *
 * @param tableName 条件所属表名。
 * @param table 表字段定义。
 * @param field 条件引用的字段名。
 * @returns 对应的字段定义。
 */
function requireFilterColumn(tableName: string, table: RelationalTableDefinition, field: string) {
  const column = table.columns[field]
  if (column === undefined) {
    throw new RelationalError("invalid-field", `表 '${tableName}' 不存在字段 '${field}'`)
  }
  return column
}
