import type { RelationalFilter } from "./filter.js"
import type { JsonValue, RelationalRecord } from "./json.js"
import type { RelationalOperation } from "./operation.js"
import { requireTable, type RelationalSchemaDefinition } from "./schema.js"

/** write-back 队列根据操作内容推导出的调度与缓存属性。 */
export interface RelationalOperationTraits {
  /** read 操作不进入写队列，write 操作会改变数据。 */
  readonly access: "read" | "write"
  /** 精确到单条记录时生成的表内顺序键；上层还需拼接 source。 */
  readonly consistencyKey?: string
  /** replaceable 可以被同键新值覆盖，ordered 必须保留原顺序。 */
  readonly merge: "not-applicable" | "replaceable" | "ordered"
  /** 发生明确临时错误时，是否可以安全重复执行。 */
  readonly retry: "idempotent" | "unsafe"
  /** 是否应让该表已有的条件查询缓存失效。 */
  readonly invalidatesQueryCache: boolean
}

/**
 * 推导 write-back 调度所需的稳定属性。
 * consistencyKey 只在能够证明操作精确针对一个主键时生成；上层还需补充 source。
 *
 * @param schema 操作所属数据源的逻辑 Schema。
 * @param operation 需要分析的关系型操作。
 * @returns 可供队列排序、合并、重试和缓存失效使用的特征。
 * @throws {RelationalError} 操作引用未声明表时抛出。
 */
export function relationalOperationTraits(
  schema: RelationalSchemaDefinition,
  operation: RelationalOperation,
): RelationalOperationTraits {
  const table = requireTable(schema, operation.table)

  // 不依据调用方声明，而是从操作本身推导，避免错误标记破坏写入顺序。
  switch (operation.type) {
    case "get":
      return {
        access: "read",
        consistencyKey: keyOf(operation.table, operation.key),
        merge: "not-applicable",
        retry: "idempotent",
        invalidatesQueryCache: false,
      }
    case "find":
    case "count":
      return readTraits
    case "insert": {
      const key = recordPrimaryKey(table.primaryKey, operation.value)
      return writeTraits(
        key === undefined ? undefined : keyOf(operation.table, key),
        "ordered",
        "unsafe",
      )
    }
    case "insertMany":
      return writeTraits(undefined, "ordered", "unsafe")
    case "upsert": {
      const key = recordPrimaryKey(table.primaryKey, operation.value)
      // 有明确主键的 upsert 最终状态由最后一个值决定，因此允许同键替换。
      return writeTraits(
        key === undefined ? undefined : keyOf(operation.table, key),
        key === undefined ? "ordered" : "replaceable",
        key === undefined ? "unsafe" : "idempotent",
      )
    }
    case "update": {
      const key = primaryKeyFromFilter(table.primaryKey, operation.where)
      return writeTraits(
        key === undefined ? undefined : keyOf(operation.table, key),
        "ordered",
        "unsafe",
      )
    }
    case "delete": {
      const key = primaryKeyFromFilter(table.primaryKey, operation.where)
      // 只有精确主键删除才具备稳定一致性键；范围删除必须保持原始顺序。
      return writeTraits(
        key === undefined ? undefined : keyOf(operation.table, key),
        key === undefined ? "ordered" : "replaceable",
        key === undefined ? "unsafe" : "idempotent",
      )
    }
  }
}

/** 所有非主键条件读取共享的不可变特征。 */
const readTraits: RelationalOperationTraits = Object.freeze({
  access: "read",
  merge: "not-applicable",
  retry: "idempotent",
  invalidatesQueryCache: false,
})

/**
 * 组装写操作特征，避免每个操作分支重复缓存失效语义。
 *
 * @param consistencyKey 可选的单记录顺序键。
 * @param merge 操作是否允许被同键后续值替换。
 * @param retry 临时失败后能否安全重试。
 * @returns 完整的写操作特征。
 */
function writeTraits(
  consistencyKey: string | undefined,
  merge: "replaceable" | "ordered",
  retry: "idempotent" | "unsafe",
): RelationalOperationTraits {
  return {
    access: "write",
    ...(consistencyKey === undefined ? {} : { consistencyKey }),
    merge,
    retry,
    invalidatesQueryCache: true,
  }
}

/**
 * 从待写记录中提取主键；generated 主键可能尚不存在。
 *
 * @param primaryKey 主键字段名。
 * @param record 待插入或 upsert 的记录。
 * @returns 已提供的主键值，缺失时返回 undefined。
 */
function recordPrimaryKey(primaryKey: string, record: RelationalRecord): JsonValue | undefined {
  return record[primaryKey]
}

/**
 * 仅从 eq 或 and 中提取唯一、可证明的主键值。
 * or、not 和范围条件都不能安全归入单记录一致性队列。
 *
 * @param primaryKey 主键字段名。
 * @param filter 待分析的条件树。
 * @returns 唯一明确的主键值，无法证明时返回 undefined。
 */
function primaryKeyFromFilter(primaryKey: string, filter: RelationalFilter): JsonValue | undefined {
  if (filter.type === "eq" && filter.field === primaryKey) {
    return filter.value
  }
  if (filter.type !== "and") {
    return undefined
  }

  // 多个主键等值条件可能互相冲突，因此只接受恰好一次匹配。
  const matches = filter.conditions
    .map((condition) => primaryKeyFromFilter(primaryKey, condition))
    .filter((value): value is JsonValue => value !== undefined)
  return matches.length === 1 ? matches[0] : undefined
}

/**
 * 将表名与 JSON 主键编码为稳定的表内一致性键。
 *
 * @param table 逻辑表名。
 * @param value 主键 JSON 值。
 * @returns 可供 write-back 队列分区的稳定字符串。
 */
function keyOf(table: string, value: JsonValue): string {
  return `${table}:${JSON.stringify(value)}`
}
