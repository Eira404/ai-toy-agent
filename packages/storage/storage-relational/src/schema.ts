import { RelationalError } from "./error.js"
import { isJsonValue, type JsonValue, type RelationalRecord } from "./json.js"

/** 逻辑表名、字段名和索引名允许使用的可移植标识符格式。 */
export const RELATIONAL_IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

/** 所有关系型 adapter 必须支持的最小字段类型集合。 */
export type RelationalColumnType = "string" | "integer" | "number" | "boolean" | "datetime" | "json"

/** 一个逻辑字段的类型和写入约束。 */
export interface RelationalColumnDefinition {
  /** 跨数据库保持一致的逻辑类型。 */
  readonly type: RelationalColumnType
  /** 是否允许保存 null。 */
  readonly nullable?: boolean
  /** 数据库或 adapter 可以生成该字段；插入时允许省略。 */
  readonly generated?: boolean
  /**
   * 常量默认值（SQL 字面量/表达式），用于 CREATE TABLE / ADD COLUMN 的 DEFAULT，
   * 例如 `"0"`、`"false"`、`"now()"`。
   */
  readonly default?: string
  /**
   * 新增列时为存量行回填的 SQL 表达式。PostgreSQL 的 DEFAULT 不能引用本表其它列，
   * 因此「初始值 = 另一列」必须用回填实现，例如 `"updated_at"`、`"0"`。
   */
  readonly backfill?: string
}

/**
 * 一个单列或复合索引的逻辑声明。
 *
 * 索引用于加速按字段过滤、排序或唯一性检查。它不是查询缓存：内存实现可以据此维护
 * 二级索引，数据库 adapter 可以据此检查或创建对应数据库索引。当前协议包只校验声明，
 * 不负责执行数据库迁移。
 *
 * 复合索引的字段顺序具有意义。例如 `["tenantId", "createdAt"]` 适合先按 tenantId
 * 过滤、再按 createdAt 排序；它通常不能等价替代只以 createdAt 开头的索引。
 *
 * @example 单字段普通索引
 * ```ts
 * const index: RelationalIndexDefinition = {
 *   name: "users_email",
 *   fields: ["email"],
 * }
 * ```
 *
 * @example 复合唯一索引
 * ```ts
 * const index: RelationalIndexDefinition = {
 *   name: "users_tenant_email",
 *   fields: ["tenantId", "email"],
 *   unique: true,
 * }
 * ```
 */
export interface RelationalIndexDefinition {
  /** Schema 内稳定且唯一的索引名。 */
  readonly name: string
  /** 组成索引的有序字段列表。 */
  readonly fields: readonly string[]
  /** 是否要求字段组合唯一。 */
  readonly unique?: boolean
}

/** 一张逻辑表的主键、字段和索引。 */
export interface RelationalTableDefinition {
  /** columns 中作为主键的字段名。 */
  readonly primaryKey: string
  /** 按字段名索引的逻辑字段声明。 */
  readonly columns: Readonly<Record<string, RelationalColumnDefinition>>
  /**
   * adapter 或内存实现可以据此建立的二级索引。
   *
   * 主键已经拥有独立的精确查询语义，不需要再次声明为普通索引。
   */
  readonly indexes?: readonly RelationalIndexDefinition[]
}

/**
 * 一个命名数据源需要遵守的完整逻辑表集合。
 *
 * @example
 * ```ts
 * const schema: RelationalSchemaDefinition = {
 *   tables: {
 *     users: {
 *       primaryKey: "id",
 *       columns: {
 *         id: { type: "string" },
 *         email: { type: "string" },
 *       },
 *       indexes: [{ name: "users_email", fields: ["email"], unique: true }],
 *     },
 *   },
 * }
 * ```
 */
export interface RelationalSchemaDefinition {
  readonly tables: Readonly<Record<string, RelationalTableDefinition>>
}

/**
 * 声明并立即校验逻辑 Schema；返回值保留调用方的字面量类型。
 *
 * @param schema 业务声明的逻辑表、字段、主键和索引。
 * @returns 原始 Schema 对象，便于 TypeScript 保留字段字面量。
 * @throws {RelationalError} 表为空、标识符非法或索引/主键引用错误时抛出。
 *
 * @example 定义一张带普通索引的用户表
 * ```ts
 * const schema = ctx.storageRelational.defineSchema({
 *   tables: {
 *     users: {
 *       primaryKey: "id",
 *       columns: {
 *         id: { type: "string" },
 *         name: { type: "string" },
 *         createdAt: { type: "datetime" },
 *       },
 *       indexes: [{ name: "users_created_at", fields: ["createdAt"] }],
 *     },
 *   },
 * })
 * ```
 *
 * @example 定义租户内邮箱唯一的复合索引
 * ```ts
 * const schema = ctx.storageRelational.defineSchema({
 *   tables: {
 *     users: {
 *       primaryKey: "id",
 *       columns: {
 *         id: { type: "string" },
 *         tenantId: { type: "string" },
 *         email: { type: "string" },
 *       },
 *       indexes: [
 *         {
 *           name: "users_tenant_email",
 *           fields: ["tenantId", "email"],
 *           unique: true,
 *         },
 *       ],
 *     },
 *   },
 * })
 * ```
 */
export function defineRelationalSchema<const S extends RelationalSchemaDefinition>(schema: S): S {
  // 转为条目数组，便于先判空，再按统一顺序逐表校验。
  const tableEntries = Object.entries(schema.tables)
  if (tableEntries.length === 0) {
    throw schemaError("Schema 至少需要一张表")
  }

  for (const [tableName, table] of tableEntries) {
    assertIdentifier(tableName, "表名")
    const columnEntries = Object.entries(table.columns)
    if (columnEntries.length === 0) {
      throw schemaError(`表 '${tableName}' 至少需要一个字段`)
    }
    for (const [field, column] of columnEntries) {
      assertIdentifier(field, `表 '${tableName}' 的字段名`)
      assertColumnDefinition(tableName, field, column)
    }

    // 主键必须引用真实字段，且 null 无法作为稳定的一致性键。
    const primary = table.columns[table.primaryKey]
    if (primary === undefined) {
      throw schemaError(`表 '${tableName}' 的主键字段 '${table.primaryKey}' 不存在`)
    }
    if (primary.nullable === true) {
      throw schemaError(`表 '${tableName}' 的主键字段 '${table.primaryKey}' 不能允许 null`)
    }

    // 同一张表内使用 Set 同时检查索引名和复合索引字段是否重复。
    const indexNames = new Set<string>()
    for (const index of table.indexes ?? []) {
      assertIdentifier(index.name, `表 '${tableName}' 的索引名`)
      if (indexNames.has(index.name)) {
        throw schemaError(`表 '${tableName}' 包含重复索引 '${index.name}'`)
      }
      indexNames.add(index.name)
      if (index.fields.length === 0) {
        throw schemaError(`表 '${tableName}' 的索引 '${index.name}' 至少需要一个字段`)
      }
      const fields = new Set<string>()
      for (const field of index.fields) {
        if (table.columns[field] === undefined) {
          throw schemaError(`表 '${tableName}' 的索引 '${index.name}' 引用了未知字段 '${field}'`)
        }
        if (fields.has(field)) {
          throw schemaError(`表 '${tableName}' 的索引 '${index.name}' 重复引用字段 '${field}'`)
        }
        fields.add(field)
      }
    }
  }

  return schema
}

/**
 * 查找逻辑表，不存在时抛出稳定错误。
 *
 * @param schema 要查询的逻辑 Schema。
 * @param tableName 目标表名。
 * @returns 对应的表定义。
 * @throws {RelationalError} 表名没有在 Schema 中声明时抛出。
 */
export function requireTable(
  schema: RelationalSchemaDefinition,
  tableName: string,
): RelationalTableDefinition {
  const table = schema.tables[tableName]
  if (table === undefined) {
    throw new RelationalError("table-not-found", `关系型 Schema 中不存在表 '${tableName}'`)
  }
  return table
}

/**
 * 校验记录字段和值；patch 模式禁止修改主键且允许空对象由调用方另行判断。
 *
 * @param tableName 用于生成明确错误信息的表名。
 * @param table 记录必须遵守的表定义。
 * @param record 待插入或待更新的普通 JSON 对象。
 * @param mode insert 校验主键存在性，patch 禁止修改主键。
 * @returns 记录合法时无返回值。
 * @throws {RelationalError} 存在未知字段、非法值或主键错误时抛出。
 */
export function assertRecord(
  tableName: string,
  table: RelationalTableDefinition,
  record: RelationalRecord,
  mode: "insert" | "patch",
): void {
  if (!isPlainRecord(record)) {
    throw new RelationalError("invalid-value", `表 '${tableName}' 的记录必须是普通 JSON 对象`)
  }

  for (const [field, value] of Object.entries(record)) {
    const column = table.columns[field]
    if (column === undefined) {
      throw new RelationalError("invalid-field", `表 '${tableName}' 不存在字段 '${field}'`)
    }
    if (mode === "patch" && field === table.primaryKey) {
      throw new RelationalError("invalid-operation", `不能通过 patch 修改表 '${tableName}' 的主键`)
    }
    assertColumnValue(tableName, field, column, value)
  }

  if (mode === "insert") {
    // generated 主键由数据库生成；其他主键必须由调用方显式提供。
    const primary = table.columns[table.primaryKey]
    if (primary?.generated !== true && !(table.primaryKey in record)) {
      throw new RelationalError(
        "invalid-value",
        `表 '${tableName}' 的插入记录缺少主键 '${table.primaryKey}'`,
      )
    }
  }
}

/**
 * 校验某个字段值是否符合逻辑字段类型。
 *
 * @param tableName 字段所属表名。
 * @param field 字段名。
 * @param column 字段的逻辑类型与 nullable/generated 声明。
 * @param value 待校验的未知输入。
 * @returns 值合法时收窄为 JsonValue。
 * @throws {RelationalError} null 或实际类型不符合字段定义时抛出。
 */
export function assertColumnValue(
  tableName: string,
  field: string,
  column: RelationalColumnDefinition,
  value: unknown,
): asserts value is JsonValue {
  if (value === null) {
    if (column.nullable === true) {
      return
    }
    throw new RelationalError("invalid-value", `表 '${tableName}' 的字段 '${field}' 不允许 null`)
  }

  // 使用逻辑类型而不是数据库驱动类型，确保内存与不同数据库得到相同判定。
  let valid = false
  switch (column.type) {
    case "string":
      valid = typeof value === "string"
      break
    case "integer":
      valid = typeof value === "number" && Number.isSafeInteger(value)
      break
    case "number":
      valid = typeof value === "number" && Number.isFinite(value)
      break
    case "boolean":
      valid = typeof value === "boolean"
      break
    case "datetime":
      valid = typeof value === "string" && value.length > 0 && !Number.isNaN(Date.parse(value))
      break
    case "json":
      valid = isJsonValue(value)
      break
  }
  if (!valid) {
    throw new RelationalError(
      "invalid-value",
      `表 '${tableName}' 的字段 '${field}' 不符合类型 '${column.type}'`,
    )
  }
}

/**
 * 校验跨数据库可安全引用的逻辑标识符。
 *
 * @param value 表名、字段名或索引名。
 * @param label 错误信息中使用的标识符类别。
 * @returns 标识符合法时无返回值。
 * @throws {RelationalError} 标识符不符合固定格式时抛出。
 */
export function assertIdentifier(value: string, label: string): void {
  if (!RELATIONAL_IDENTIFIER_RE.test(value)) {
    throw schemaError(`${label} '${value}' 必须匹配 ${RELATIONAL_IDENTIFIER_RE}`)
  }
}

/**
 * 校验字段声明使用的是协议支持的逻辑类型。
 *
 * @param tableName 字段所属表名。
 * @param field 字段名。
 * @param column 待检查的字段声明。
 * @returns 字段声明合法时无返回值。
 */
function assertColumnDefinition(
  tableName: string,
  field: string,
  column: RelationalColumnDefinition,
): void {
  const supported: readonly RelationalColumnType[] = [
    "string",
    "integer",
    "number",
    "boolean",
    "datetime",
    "json",
  ]
  if (!supported.includes(column.type)) {
    throw schemaError(`表 '${tableName}' 的字段 '${field}' 使用了不支持的类型`)
  }
  if (column.default !== undefined && column.default.trim().length === 0) {
    throw schemaError(`表 '${tableName}' 的字段 '${field}' 的 default 不能是空字符串`)
  }
  if (column.backfill !== undefined && column.backfill.trim().length === 0) {
    throw schemaError(`表 '${tableName}' 的字段 '${field}' 的 backfill 不能是空字符串`)
  }
}

/**
 * 判断输入是否为无自定义原型的普通 JSON 对象。
 *
 * @param value 待检查的未知输入。
 * @returns true 表示输入可以作为关系型记录使用。
 */
function isPlainRecord(value: unknown): value is RelationalRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false
  }
  const prototype = Object.getPrototypeOf(value) as object | null
  return (prototype === Object.prototype || prototype === null) && isJsonValue(value)
}

/**
 * 创建统一携带 invalid-schema 错误码的异常。
 *
 * @param message Schema 校验失败的诊断信息。
 * @returns 可直接抛出的关系型协议错误。
 */
function schemaError(message: string): RelationalError {
  return new RelationalError("invalid-schema", message)
}
