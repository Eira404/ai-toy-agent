import type {
  RelationalAdapter,
  RelationalFilter,
  RelationalRecord,
} from "toy-storage-relational"
import type { VectorAdapter } from "toy-storage-vector"
import { LongMemoryError } from "./error.js"
import { normalizeKey } from "./normalize.js"
import { LONG_VECTOR_COLLECTION, longRelationalSchema } from "./schema.js"
import type {
  LifecycleStatus,
  LongBlock,
  LongDetail,
  LongDomain,
  ValueState,
  Scope,
} from "./types.js"

/**
 * 关系表行（snake_case）与公共类型（camelCase）之间的映射。
 *
 * 行由 adapter 返回或写入，字段名与 `schema.ts` 保持一致；对外只暴露
 * camelCase 的领域类型，避免上层接触数据库命名。
 */

/** 关系表行还原出的块内部对象，比公开 LongBlock 多出隔离字段，供校验后剥离。 */
export interface BlockRow {
  blockId: string
  userId: string
  memorySpaceId: string
  domain: LongDomain
  title: string
  summary: string
  overviewBody: string
  lifecycleStatus: LifecycleStatus
  value: ValueState
  createdAt: string
  updatedAt: string
  contentUpdatedAt: string
}

const LIFECYCLE_STATES: readonly LifecycleStatus[] = ["active", "observing", "archived"]
const DOMAINS: readonly LongDomain[] = ["self", "person", "project", "topic", "entity", "event"]

/** 将公开块对象转换为关系表行（不含细节与别名，两者单独成表）。 */
export function blockRow(block: LongBlock, scope: Scope): RelationalRecord {
  return {
    block_id: block.blockId,
    user_id: scope.userId,
    memory_space_id: scope.memorySpaceId,
    domain: block.domain,
    title: block.title,
    title_key: normalizeKey(block.title),
    summary: block.summary,
    overview_body: block.overviewBody,
    lifecycle_status: block.lifecycleStatus,
    value_version: block.value.valueVersion,
    value_state: block.value.valueData,
    created_at: block.createdAt,
    updated_at: block.updatedAt,
    content_updated_at: block.contentUpdatedAt,
  }
}

/** 将关系表行还原为块内部对象；aliases 与 details 由 service 另行聚合。 */
export function blockFromRow(row: RelationalRecord): BlockRow {
  const domain = enumField(row, "domain", DOMAINS)
  const lifecycleStatus = enumField(row, "lifecycle_status", LIFECYCLE_STATES)
  return {
    blockId: asString(row, "block_id"),
    userId: asString(row, "user_id"),
    memorySpaceId: asString(row, "memory_space_id"),
    domain,
    title: asString(row, "title"),
    summary: asString(row, "summary"),
    overviewBody: asString(row, "overview_body"),
    lifecycleStatus,
    value: {
      valueVersion: asString(row, "value_version"),
      valueData: jsonField(row, "value_state"),
    },
    createdAt: asString(row, "created_at"),
    updatedAt: asString(row, "updated_at"),
    contentUpdatedAt: asString(row, "content_updated_at"),
  }
}

/** 将细节领域对象转换为关系表行；scope 由所属块继承。 */
export function detailRow(detail: LongDetail, blockId: string, scope: Scope): RelationalRecord {
  return {
    detail_id: detail.detailId,
    block_id: blockId,
    user_id: scope.userId,
    memory_space_id: scope.memorySpaceId,
    summary: detail.summary,
    body: detail.body,
    lifecycle_status: detail.lifecycleStatus,
    value_version: detail.value.valueVersion,
    value_state: detail.value.valueData,
    created_at: detail.createdAt,
    updated_at: detail.updatedAt,
  }
}

/** 将关系表行还原为细节领域对象。 */
export function detailFromRow(row: RelationalRecord): LongDetail {
  return {
    detailId: asString(row, "detail_id"),
    summary: asString(row, "summary"),
    body: asString(row, "body"),
    lifecycleStatus: enumField(row, "lifecycle_status", LIFECYCLE_STATES),
    value: {
      valueVersion: asString(row, "value_version"),
      valueData: jsonField(row, "value_state"),
    },
    createdAt: asString(row, "created_at"),
    updatedAt: asString(row, "updated_at"),
  }
}

/** 构造别名行；`aliasKey` 使用规范化 key，保证完全匹配一致性。 */
export function aliasRow(blockId: string, scope: Scope, alias: string, aliasKey: string): RelationalRecord {
  return {
    alias_id: `${blockId}:${aliasKey}`,
    block_id: blockId,
    user_id: scope.userId,
    memory_space_id: scope.memorySpaceId,
    alias,
    alias_key: aliasKey,
  }
}

/**
 * 校验命名 adapter 是否配置了本包需要的表与向量集合。
 *
 * 只核对表名、主键、字段类型、索引与向量过滤字段，不负责数据库迁移；
 * 由宿主持有本包导出的 Schema 并交给具体 adapter 创建结构。
 */
export function assertLongSchema(relational: RelationalAdapter, vector: VectorAdapter): void {
  for (const [name, required] of Object.entries(longRelationalSchema.tables)) {
    const actual = relational.schema.tables[name]
    if (actual?.primaryKey !== required.primaryKey) {
      throw new LongMemoryError("schema-mismatch", `数据源缺少正确的 '${name}' 表或主键`)
    }
    for (const [field, expected] of Object.entries(required.columns)) {
      const column = actual.columns[field]
      const nullable = "nullable" in expected && expected.nullable === true
      if (column?.type !== expected.type || (column.nullable === true) !== nullable) {
        throw new LongMemoryError(
          "schema-mismatch",
          `数据源字段 '${name}.${field}' 与 Long 定义不一致`,
        )
      }
    }
    for (const index of required.indexes) {
      const found = actual.indexes?.some(
        (candidate) =>
          candidate.name === index.name &&
          (candidate.unique === true) === ("unique" in index && index.unique === true) &&
          candidate.fields.length === index.fields.length &&
          candidate.fields.every((field, position) => field === index.fields[position]),
      )
      if (!found) {
        throw new LongMemoryError("schema-mismatch", `数据源缺少 '${name}.${index.name}' 索引定义`)
      }
    }
  }

  const collection = vector.schema.collections[LONG_VECTOR_COLLECTION]
  if (collection === undefined) {
    throw new LongMemoryError("schema-mismatch", `向量存储缺少 '${LONG_VECTOR_COLLECTION}' 集合`)
  }
  for (const field of ["userId", "memorySpaceId", "domain", "blockId", "recordType"]) {
    if (collection.filterFields?.[field] !== "string") {
      throw new LongMemoryError(
        "schema-mismatch",
        `向量集合 '${LONG_VECTOR_COLLECTION}' 缺少 string 过滤字段 '${field}'`,
      )
    }
  }
}

/** 构造 scope 隔离条件（user_id + memory_space_id）。 */
export function scopeWhere(scope: Scope): RelationalFilter {
  return andWhere([eq("user_id", scope.userId), eq("memory_space_id", scope.memorySpaceId)])
}

/** 构造单字段相等条件。 */
export function eq(field: string, value: string): RelationalFilter {
  return { type: "eq", field, value }
}

/** 构造多条件 AND 组合。 */
export function andWhere(conditions: readonly RelationalFilter[]): RelationalFilter {
  return { type: "and", conditions: [...conditions] }
}

/** 构造单字段 in 条件。 */
export function inSet(field: string, values: readonly string[]): RelationalFilter {
  return { type: "in", field, values: [...values] }
}

function asString(row: RelationalRecord, field: string): string {
  const value = row[field]
  if (typeof value !== "string") {
    throw new LongMemoryError("schema-mismatch", `关系表字段 '${field}' 不是字符串`)
  }
  return value
}

function jsonField(row: RelationalRecord, field: string): ValueState["valueData"] {
  const value = row[field]
  if (value === undefined || value === null) {
    throw new LongMemoryError("schema-mismatch", `关系表字段 '${field}' 缺失或为 null`)
  }
  return value
}

function enumField<T extends string>(row: RelationalRecord, field: string, allowed: readonly T[]): T {
  const value = asString(row, field)
  if (!allowed.includes(value as T)) {
    throw new LongMemoryError("schema-mismatch", `关系表字段 '${field}' 包含未知值 '${value}'`)
  }
  return value as T
}
