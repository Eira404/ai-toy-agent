import { VectorError } from "./error.js"
import { assertFilter, type VectorFilter } from "./filter.js"
import { isJsonObject, isPlainRecord, type JsonObject } from "./json.js"
import {
  assertFieldValue,
  requireCollection,
  type VectorCollectionDefinition,
  type VectorFieldValue,
  type VectorSchemaDefinition,
} from "./schema.js"

const MAX_SEARCH_LIMIT = 100

/** 向量集合中的完整记录。 */
export interface VectorRecord {
  /** 由调用方分配，在集合内唯一且可用于重复写入。 */
  readonly id: string
  /** 按集合的固定维度保存的稠密向量。 */
  readonly vector: readonly number[]
  /** 完整提供集合声明的过滤字段，未声明字段时使用空对象。 */
  readonly fields: Readonly<Record<string, VectorFieldValue>>
  /** 可随记录读取的业务数据。 */
  readonly payload?: JsonObject
}

/** 按集合内的 ID 插入或整体替换记录，省略 payload 时清除旧值。 */
export interface VectorUpsertOperation {
  readonly type: "upsert"
  readonly collection: string
  readonly value: VectorRecord
}

/** 批量插入或整体替换同一集合中的完整记录。 */
export interface VectorUpsertManyOperation {
  readonly type: "upsertMany"
  readonly collection: string
  readonly values: readonly VectorRecord[]
}

/** 按集合内的 ID 读取完整记录，包含向量。 */
export interface VectorGetOperation {
  readonly type: "get"
  readonly collection: string
  readonly id: string
}

/** 按集合内的 ID 删除记录，允许重复调用。 */
export interface VectorDeleteOperation {
  readonly type: "delete"
  readonly collection: string
  readonly id: string
}

/** 按 ID 批量删除同一集合中的记录，允许 ID 重复或不存在。 */
export interface VectorDeleteManyOperation {
  readonly type: "deleteMany"
  readonly collection: string
  readonly ids: readonly string[]
}

/** 在指定集合中按距离检索最近的记录。 */
export interface VectorSearchOperation {
  readonly type: "search"
  readonly collection: string
  /** 用于比较距离的查询向量，维度与集合一致。 */
  readonly vector: readonly number[]
  /** 在计算 Top K 之前应用的候选记录条件。 */
  readonly where?: VectorFilter
  /** 最多返回的匹配条数，范围为 1 到 100。 */
  readonly limit: number
}

/** adapter 接受的操作，可通过 type 区分。 */
export type VectorOperation =
  | VectorUpsertOperation
  | VectorUpsertManyOperation
  | VectorGetOperation
  | VectorDeleteOperation
  | VectorDeleteManyOperation
  | VectorSearchOperation

/**
 * 按目标集合的 Schema 校验操作，可用于入队前校验，也可用于 adapter 执行入口。
 *
 * @param schema 已校验的向量集合定义。
 * @param operation 来自业务代码、队列或其他调用边界的操作数据。
 * @throws {VectorError} 操作格式、集合、字段、向量或查询条件非法时抛出。
 */
export function assertOperation(schema: VectorSchemaDefinition, operation: unknown): void {
  if (
    !isPlainRecord(operation) ||
    typeof operation.type !== "string" ||
    typeof operation.collection !== "string"
  ) {
    throw new VectorError("invalid-operation", "向量操作必须指定 type 和 collection")
  }

  const collection = requireCollection(schema, operation.collection)
  switch (operation.type) {
    case "upsert":
      assertRecord(collection, operation.value)
      return
    case "upsertMany": {
      if (!Array.isArray(operation.values) || operation.values.length === 0) {
        throw new VectorError("invalid-operation", "upsertMany 至少需要一条记录")
      }
      const ids = new Set<string>()
      for (const record of operation.values) {
        assertRecord(collection, record)
        if (ids.has(record.id)) {
          throw new VectorError("invalid-value", `upsertMany 包含重复的 id '${record.id}'`)
        }
        ids.add(record.id)
      }
      return
    }
    case "get":
    case "delete":
      assertId(operation.id)
      return
    case "deleteMany":
      if (!Array.isArray(operation.ids) || operation.ids.length === 0) {
        throw new VectorError("invalid-operation", "deleteMany 至少需要一个 id")
      }
      for (const id of operation.ids) {
        assertId(id)
      }
      return
    case "search":
      assertVector(collection, operation.vector)
      assertLimit(operation.limit)
      if (operation.where !== undefined) {
        assertFilter(collection, operation.where)
      }
      return
    default:
      throw new VectorError("invalid-operation", `未知的向量操作 '${operation.type}'`)
  }
}

function assertId(id: unknown): void {
  if (typeof id !== "string" || id.trim().length === 0) {
    throw new VectorError("invalid-value", "向量记录的 id 必须是非空字符串")
  }
}

function assertRecord(
  collection: VectorCollectionDefinition,
  record: unknown,
): asserts record is VectorRecord {
  if (!isPlainRecord(record)) {
    throw new VectorError("invalid-operation", "向量写入必须提供完整记录")
  }
  assertId(record.id)
  assertVector(collection, record.vector)

  const { fields, payload } = record
  if (!isPlainRecord(fields)) {
    throw new VectorError("invalid-value", "向量记录的 fields 必须是对象")
  }
  for (const [field, value] of Object.entries(fields)) {
    assertFieldValue(collection, field, value)
  }
  // upsert 是整体替换，省略已声明的字段会让检索条件失去明确含义。
  for (const field of Object.keys(collection.filterFields ?? {})) {
    if (!Object.prototype.propertyIsEnumerable.call(fields, field)) {
      throw new VectorError("invalid-field", `向量记录缺少过滤字段 '${field}'`)
    }
  }
  if (payload !== undefined && !isJsonObject(payload)) {
    throw new VectorError("invalid-value", "向量记录的 payload 必须是有效的 JSON 对象")
  }
}

/** 写入与检索都校验维度和数值，使同一集合中的距离始终有定义。 */
function assertVector(collection: VectorCollectionDefinition, vector: unknown): void {
  if (!Array.isArray(vector) || vector.length !== collection.dimensions) {
    throw new VectorError("invalid-value", `向量必须是长度为 ${collection.dimensions} 的数组`)
  }
  let hasNonzeroValue = false
  for (const value of vector) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new VectorError("invalid-value", "向量分量必须是有限数值")
    }
    hasNonzeroValue ||= value !== 0
  }
  // 只需要判断是否全零，避免通过计算平方和引入额外的溢出或下溢。
  if (collection.metric === "cosine" && !hasNonzeroValue) {
    throw new VectorError("invalid-value", "cosine 距离要求向量至少有一个非零分量")
  }
}

function assertLimit(limit: unknown): void {
  if (
    typeof limit !== "number" ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > MAX_SEARCH_LIMIT
  ) {
    throw new VectorError(
      "invalid-operation",
      `search 的 limit 必须是 1 到 ${MAX_SEARCH_LIMIT} 的整数`,
    )
  }
}
