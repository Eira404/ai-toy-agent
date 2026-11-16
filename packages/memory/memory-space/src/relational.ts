import type {
  RelationalAdapter,
  RelationalFilter,
  RelationalRecord,
} from "toy-storage-relational"
import { MemorySpaceError } from "./error.js"
import { spaceRelationalSchema } from "./schema.js"
import type { DeviceBinding, MemorySpace, SpaceStatus } from "./types.js"

/**
 * 关系表行（snake_case）与公共类型（camelCase）之间的映射。
 *
 * 行由 adapter 返回或写入，字段名与 `schema.ts` 保持一致；对外只暴露
 * camelCase 的领域类型，避免上层接触数据库命名。`binding_id` 是数据库
 * 主键，不属于业务身份，因此不出现在公开的 `DeviceBinding` 里。
 */

const SPACE_STATUSES: readonly SpaceStatus[] = ["active", "deleted"]

/** 将公开空间对象转换为关系表行。 */
export function spaceRow(space: MemorySpace): RelationalRecord {
  return {
    memory_space_id: space.memorySpaceId,
    user_id: space.userId,
    name: space.name,
    status: space.status,
    created_at: space.createdAt,
    updated_at: space.updatedAt,
  }
}

/** 将关系表行还原为公开空间对象。 */
export function spaceFromRow(row: RelationalRecord): MemorySpace {
  return {
    memorySpaceId: asString(row, "memory_space_id"),
    userId: asString(row, "user_id"),
    name: nullableString(row, "name"),
    status: enumField(row, "status", SPACE_STATUSES),
    createdAt: asString(row, "created_at"),
    updatedAt: asString(row, "updated_at"),
  }
}

/** 将娃娃绑定输入转换为关系表行。 */
export function bindingRow(
  bindingId: string,
  input: { readonly userId: string; readonly deviceId: string; readonly memorySpaceId: string },
  createdAt: string,
): RelationalRecord {
  return {
    binding_id: bindingId,
    user_id: input.userId,
    device_id: input.deviceId,
    memory_space_id: input.memorySpaceId,
    created_at: createdAt,
  }
}

/** 将关系表行还原为公开绑定对象（不含 binding_id）。 */
export function bindingFromRow(row: RelationalRecord): DeviceBinding {
  return {
    userId: asString(row, "user_id"),
    deviceId: asString(row, "device_id"),
    memorySpaceId: asString(row, "memory_space_id"),
    createdAt: asString(row, "created_at"),
  }
}

/**
 * 校验命名 adapter 是否配置了本包需要的表。
 *
 * 只核对表名、主键、字段类型、可空性与索引，不负责数据库迁移；
 * 由宿主持有本包导出的 Schema 并交给具体 adapter 创建结构。
 */
export function assertSpaceSchema(relational: RelationalAdapter): void {
  for (const [name, required] of Object.entries(spaceRelationalSchema.tables)) {
    const actual = relational.schema.tables[name]
    if (actual?.primaryKey !== required.primaryKey) {
      throw new MemorySpaceError("schema-mismatch", `数据源缺少正确的 '${name}' 表或主键`)
    }
    for (const [field, expected] of Object.entries(required.columns)) {
      const column = actual.columns[field]
      const nullable = "nullable" in expected && expected.nullable === true
      if (column?.type !== expected.type || (column.nullable === true) !== nullable) {
        throw new MemorySpaceError("schema-mismatch", `数据源字段 '${name}.${field}' 与 Space 定义不一致`)
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
        throw new MemorySpaceError("schema-mismatch", `数据源缺少 '${name}.${index.name}' 索引定义`)
      }
    }
  }
}

/** 构造单字段相等条件。 */
export function eq(field: string, value: string): RelationalFilter {
  return { type: "eq", field, value }
}

/** 构造多条件 AND 组合。 */
export function andWhere(conditions: readonly RelationalFilter[]): RelationalFilter {
  return { type: "and", conditions: [...conditions] }
}

function asString(row: RelationalRecord, field: string): string {
  const value = row[field]
  if (typeof value !== "string") {
    throw new MemorySpaceError("schema-mismatch", `关系表字段 '${field}' 不是字符串`)
  }
  return value
}

function nullableString(row: RelationalRecord, field: string): string | null {
  const value = row[field]
  if (value === null || value === undefined) {
    return null
  }
  if (typeof value !== "string") {
    throw new MemorySpaceError("schema-mismatch", `关系表字段 '${field}' 不是字符串`)
  }
  return value
}

function enumField<T extends string>(row: RelationalRecord, field: string, allowed: readonly T[]): T {
  const value = asString(row, field)
  if (!allowed.includes(value as T)) {
    throw new MemorySpaceError("schema-mismatch", `关系表字段 '${field}' 包含未知值 '${value}'`)
  }
  return value as T
}
