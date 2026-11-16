import {
  RelationalError,
  type JsonValue,
  type RelationalFilter,
  type RelationalOperation,
  type RelationalRecord,
  type RelationalSchemaDefinition,
  type RelationalTableDefinition,
} from "toy-storage-relational"
import { qualifiedTable, quoteIdentifier } from "./sql.js"

/** 一条已经完成标识符转义和参数收集的 SQL 语句。 */
export interface CompiledQuery {
  readonly text: string
  readonly values: readonly unknown[]
}

class Parameters {
  readonly values: unknown[] = []

  add(value: JsonValue, type: RelationalTableDefinition["columns"][string]["type"]): string {
    this.values.push(type === "json" ? JSON.stringify(value) : value)
    const position = `$${this.values.length}`
    return type === "json" ? `${position}::jsonb` : position
  }

  addRaw(value: unknown): string {
    this.values.push(value)
    return `$${this.values.length}`
  }
}

/**
 * 将关系型操作编译成参数化 PostgreSQL SQL。调用方应先通过协议服务校验操作。
 *
 * @param schema 已校验的逻辑 Schema。
 * @param schemaName PostgreSQL schema 名称。
 * @param operation 关系型操作。
 * @returns SQL 文本和按位置排列的参数。
 */
export function compileOperation(
  schema: RelationalSchemaDefinition,
  schemaName: string,
  operation: RelationalOperation,
): CompiledQuery {
  const table = schema.tables[operation.table]
  if (table === undefined) {
    throw new RelationalError("table-not-found", `表 '${operation.table}' 未声明`)
  }
  const name = qualifiedTable(schemaName, operation.table)
  const params = new Parameters()
  const primary = quoteIdentifier(table.primaryKey)

  switch (operation.type) {
    case "get":
      return {
        text: `SELECT * FROM ${name} WHERE ${primary} = ${params.add(operation.key, table.columns[table.primaryKey]?.type ?? "string")} LIMIT 1`,
        values: params.values,
      }
    case "find": {
      const where =
        operation.where === undefined
          ? ""
          : ` WHERE ${compileFilter(table, operation.where, params)}`
      const orders = operation.orderBy ?? []
      const fields = orders.map(
        (item) => `${quoteIdentifier(item.field)} ${item.direction.toUpperCase()}`,
      )
      if (!orders.some((item) => item.field === table.primaryKey)) {
        fields.push(`${primary} ASC`)
      }
      const limit = operation.limit === undefined ? "" : ` LIMIT ${params.addRaw(operation.limit)}`
      const offset =
        operation.offset === undefined ? "" : ` OFFSET ${params.addRaw(operation.offset)}`
      return {
        text: `SELECT * FROM ${name}${where} ORDER BY ${fields.join(", ")}${limit}${offset}`,
        values: params.values,
      }
    }
    case "count":
      return {
        text: `SELECT COUNT(*)::text AS "count" FROM ${name}${operation.where === undefined ? "" : ` WHERE ${compileFilter(table, operation.where, params)}`}`,
        values: params.values,
      }
    case "insert":
      return compileInsert(name, table, [operation.value], false)
    case "insertMany":
      return compileInsert(name, table, operation.values, false)
    case "upsert":
      if (!(table.primaryKey in operation.value)) {
        throw new RelationalError("invalid-operation", "upsert 必须显式提供主键")
      }
      return compileInsert(name, table, [operation.value], true)
    case "update": {
      const assignments = Object.entries(operation.patch).map(([field, value]) => {
        const type = table.columns[field]?.type ?? "string"
        return `${quoteIdentifier(field)} = ${params.add(value, type)}`
      })
      const where = compileFilter(table, operation.where, params)
      return {
        text: `UPDATE ${name} SET ${assignments.join(", ")} WHERE ${where}`,
        values: params.values,
      }
    }
    case "delete":
      return {
        text: `DELETE FROM ${name} WHERE ${compileFilter(table, operation.where, params)}`,
        values: params.values,
      }
  }
}

function compileInsert(
  name: string,
  table: RelationalTableDefinition,
  rows: readonly RelationalRecord[],
  upsert: boolean,
): CompiledQuery {
  const params = new Parameters()
  const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))]
  const primary = quoteIdentifier(table.primaryKey)
  let text: string

  if (columns.length === 0) {
    if (rows.length !== 1) {
      throw new RelationalError("invalid-operation", "多条空记录不能批量插入")
    }
    text = `INSERT INTO ${name} DEFAULT VALUES`
  } else {
    const groups = rows.map((row) => {
      const values = columns.map((field) => {
        const value = row[field]
        return value === undefined
          ? "DEFAULT"
          : params.add(value, table.columns[field]?.type ?? "string")
      })
      return `(${values.join(", ")})`
    })
    text = `INSERT INTO ${name} (${columns.map(quoteIdentifier).join(", ")}) VALUES ${groups.join(", ")}`
  }

  if (upsert) {
    const updates = columns
      .filter((column) => column !== table.primaryKey)
      .map((column) => `${quoteIdentifier(column)} = EXCLUDED.${quoteIdentifier(column)}`)
    // PostgreSQL 的 ON CONFLICT 以主键约束保证并发 upsert 原子性。
    // 即使仅提交主键也执行无变化的 UPDATE，以便冲突时仍能返回已有记录。
    text += ` ON CONFLICT (${primary}) DO UPDATE SET ${updates.length === 0 ? `${primary} = EXCLUDED.${primary}` : updates.join(", ")}`
    // xmax 是 PostgreSQL 系统列；用于区分 INSERT 与冲突 UPDATE，需在升级时回归验证。
    text += ` RETURNING *, (xmax = 0) AS "__toy_storage_inserted"`
  } else {
    text += " RETURNING *"
  }
  return { text, values: params.values }
}

function compileFilter(
  table: RelationalTableDefinition,
  filter: RelationalFilter,
  params: Parameters,
): string {
  switch (filter.type) {
    case "and":
    case "or":
      return `(${filter.conditions.map((item) => compileFilter(table, item, params)).join(` ${filter.type.toUpperCase()} `)})`
    case "not":
      return `(NOT ${compileFilter(table, filter.condition, params)})`
    case "isNull":
      return `${quoteIdentifier(filter.field)} IS NULL`
    case "isNotNull":
      return `${quoteIdentifier(filter.field)} IS NOT NULL`
    case "like":
      return `${quoteIdentifier(filter.field)} LIKE ${params.addRaw(filter.pattern)}`
    case "in":
    case "notIn": {
      const column = quoteIdentifier(filter.field)
      if (filter.values.length === 0) {
        return filter.type === "in" ? "FALSE" : "TRUE"
      }
      const type = table.columns[filter.field]?.type ?? "string"
      const nonNull = filter.values.filter((value) => value !== null)
      const hasNull = nonNull.length !== filter.values.length
      const placeholders = nonNull.map((value) => params.add(value, type)).join(", ")
      const member = nonNull.length ? `${column} IN (${placeholders})` : "FALSE"
      if (filter.type === "in") {
        return hasNull ? `(${member} OR ${column} IS NULL)` : member
      }
      // SQL 的 NULL 三值逻辑不能直接用 NOT (col IN (...)) 表达集合补集。
      const nonMember = nonNull.length ? `${column} NOT IN (${placeholders})` : "TRUE"
      return hasNull
        ? `(${column} IS NOT NULL AND ${nonMember})`
        : `(${column} IS NULL OR ${nonMember})`
    }
    case "eq":
    case "ne": {
      const column = quoteIdentifier(filter.field)
      if (filter.value === null) {
        return `${column} IS ${filter.type === "eq" ? "" : "NOT "}NULL`
      }
      const type = table.columns[filter.field]?.type ?? "string"
      const value = params.add(filter.value, type)
      return `${column} ${filter.type === "eq" ? "=" : "IS DISTINCT FROM"} ${value}`
    }
    case "gt":
    case "gte":
    case "lt":
    case "lte": {
      if (filter.value === null) {
        throw new RelationalError("invalid-operation", "null 只能使用 eq/ne 或 isNull 条件")
      }
      const type = table.columns[filter.field]?.type ?? "string"
      if (type === "json" || type === "boolean") {
        throw new RelationalError("invalid-operation", `字段 '${filter.field}' 不支持范围比较`)
      }
      const operator = { gt: ">", gte: ">=", lt: "<", lte: "<=" }[filter.type]
      return `${quoteIdentifier(filter.field)} ${operator} ${params.add(filter.value, type)}`
    }
  }
}
