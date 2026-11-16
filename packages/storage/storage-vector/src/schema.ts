import { VectorError } from "./error.js"
import { isPlainRecord } from "./json.js"

const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/
const RESERVED_FIELDS = new Set(["id", "embedding", "payload"])

/** 集合使用的距离度量，同时约束写入与查询向量。 */
export type VectorMetric = "cosine"

/** 过滤列支持的标量类型。 */
export type VectorFieldType = "string" | "number" | "boolean"

/** 过滤列允许保存和比较的值，number 必须有限。 */
export type VectorFieldValue = string | number | boolean

/** 从过滤字段名到标量类型的声明。 */
export type VectorFieldDefinitions = Readonly<Record<string, VectorFieldType>>

/** 一个逻辑向量集合的约束。 */
export interface VectorCollectionDefinition {
  /** 写入和检索共用的固定向量维度。 */
  readonly dimensions: number
  /** 该集合用于计算向量距离的方式。 */
  readonly metric: VectorMetric
  /** 记录必须完整提供的过滤字段，省略时记录使用空 fields 对象。 */
  readonly filterFields?: VectorFieldDefinitions
}

/** 一个向量数据源接受的全部逻辑集合。 */
export interface VectorSchemaDefinition {
  readonly collections: Readonly<Record<string, VectorCollectionDefinition>>
}

/**
 * 校验集合名、向量约束和过滤字段。返回原对象，保留调用方声明的字面量类型。
 *
 * @param schema 至少包含一个集合的逻辑 Schema。
 * @returns 可交给 adapter 和操作校验使用的 Schema。
 * @throws {VectorError} Schema 结构或集合约束非法时抛出。
 */
export function defineSchema<const S extends VectorSchemaDefinition>(schema: S): S {
  if (!isPlainRecord(schema) || !isPlainRecord(schema.collections)) {
    throw new VectorError("invalid-schema", "向量 Schema 必须提供 collections 对象")
  }
  const collections = Object.entries(schema.collections)
  if (collections.length === 0) {
    throw new VectorError("invalid-schema", "向量 Schema 至少需要一个集合")
  }
  for (const [name, collection] of collections) {
    assertIdentifier(name, "集合名")
    if (!isPlainRecord(collection)) {
      throw new VectorError("invalid-schema", `集合 '${name}' 必须提供集合定义对象`)
    }
    const { dimensions, metric, filterFields } = collection
    if (typeof dimensions !== "number" || !Number.isSafeInteger(dimensions) || dimensions < 1) {
      throw new VectorError("invalid-schema", `集合 '${name}' 的 dimensions 必须是正安全整数`)
    }
    if (metric !== "cosine") {
      throw new VectorError("invalid-schema", `集合 '${name}' 的 metric 必须是 cosine`)
    }
    if (filterFields !== undefined) {
      assertFieldDefinitions(name, filterFields)
    }
  }
  return schema
}

/**
 * 按名称查找已声明的集合。仅查询自有属性，避免把对象原型上的属性当作集合。
 *
 * @param schema 已经校验过的逻辑 Schema。
 * @param name 目标集合名。
 * @returns 对应的集合定义。
 * @throws {VectorError} 集合没有声明时抛出 collection-not-found。
 */
export function requireCollection(
  schema: VectorSchemaDefinition,
  name: string,
): VectorCollectionDefinition {
  if (!Object.hasOwn(schema.collections, name)) {
    throw new VectorError("collection-not-found", `向量 Schema 中不存在集合 '${name}'`)
  }
  return schema.collections[name]!
}

/** 写入和检索共用同一套字段声明及类型校验。 */
export function assertFieldValue(
  collection: VectorCollectionDefinition,
  field: string,
  value: unknown,
): void {
  const fields = collection.filterFields
  if (fields === undefined || !Object.hasOwn(fields, field)) {
    throw new VectorError("invalid-field", `过滤字段 '${field}' 未在集合中声明`)
  }
  const type = fields[field]
  if (typeof value !== type || (typeof value === "number" && !Number.isFinite(value))) {
    throw new VectorError("invalid-value", `过滤字段 '${field}' 必须是有效的 ${type} 值`)
  }
}

function assertFieldDefinitions(collection: string, fields: unknown): void {
  if (!isPlainRecord(fields)) {
    throw new VectorError("invalid-schema", `集合 '${collection}' 的 filterFields 必须是对象`)
  }
  for (const [field, type] of Object.entries(fields)) {
    assertIdentifier(field, "过滤字段名")
    // 保留协议字段对应的列名，使 adapter 能将过滤字段直接映射到独立列。
    if (RESERVED_FIELDS.has(field)) {
      throw new VectorError("invalid-schema", `集合 '${collection}' 使用了保留字段 '${field}'`)
    }
    if (type !== "string" && type !== "number" && type !== "boolean") {
      throw new VectorError("invalid-schema", `过滤字段 '${collection}.${field}' 的类型无效`)
    }
  }
}

function assertIdentifier(value: string, label: string): void {
  if (!IDENTIFIER_RE.test(value)) {
    throw new VectorError("invalid-schema", `${label} '${value}' 必须匹配 ${IDENTIFIER_RE}`)
  }
}
