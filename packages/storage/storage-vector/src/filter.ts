import { VectorError } from "./error.js"
import { isPlainRecord } from "./json.js"
import {
  assertFieldValue,
  type VectorCollectionDefinition,
  type VectorFieldValue,
} from "./schema.js"

/** 判断一个已声明的过滤字段是否等于给定值。 */
export interface VectorEqualFilter {
  readonly type: "eq"
  readonly field: string
  readonly value: VectorFieldValue
}

/** 要求一组非空的等值条件同时成立，条件为一层列表。 */
export interface VectorAndFilter {
  readonly type: "and"
  readonly conditions: readonly VectorEqualFilter[]
}

/** 在计算 Top K 前用于限定候选记录的条件。 */
export type VectorFilter = VectorEqualFilter | VectorAndFilter

/**
 * 校验单个 eq 或非空 and 列表，逐项检查过滤字段是否已声明且值的类型匹配。
 *
 * @param collection 本次检索的集合定义。
 * @param filter 调用方给出的 where 表达式。
 * @throws {VectorError} 表达式结构、字段或值非法时抛出。
 */
export function assertFilter(collection: VectorCollectionDefinition, filter: unknown): void {
  if (isPlainRecord(filter) && filter.type === "and") {
    if (!Array.isArray(filter.conditions) || filter.conditions.length === 0) {
      throw new VectorError("invalid-operation", "and 至少需要一个 eq 条件")
    }
    for (const condition of filter.conditions) {
      assertEqualFilter(collection, condition)
    }
    return
  }
  assertEqualFilter(collection, filter)
}

function assertEqualFilter(collection: VectorCollectionDefinition, filter: unknown): void {
  if (!isPlainRecord(filter) || filter.type !== "eq" || typeof filter.field !== "string") {
    throw new VectorError("invalid-operation", "过滤条件必须是带字段名的 eq 表达式")
  }
  assertFieldValue(collection, filter.field, filter.value)
}
