import type { QueryResult } from "pg"
import {
  VectorError,
  type JsonObject,
  type VectorFieldValue,
  type VectorOperation,
  type VectorRecord,
  type VectorResult,
} from "toy-storage-vector"
import { qualifiedName, quoteIdentifier } from "./sql.js"

interface CompiledOperation {
  readonly text: string
  readonly values: unknown[]
}

const MAX_BIND_PARAMETERS = 65_535
const MAX_UPSERT_ROWS_PER_STATEMENT = 1_000

/** 系统列拥有固定别名，业务字段使用 field_N，避免与系统列或行对象属性冲突。 */
export interface ResultRow {
  readonly id: string
  readonly payload: JsonObject | null
  readonly vector: string
  readonly distance: number
  readonly [field: string]: unknown
}

/**
 * 将已通过协议校验的操作编译为参数化 SQL。标识符单独转义，业务值通过参数绑定。
 *
 * @param schemaName 集合表所在的 PostgreSQL schema。
 * @param extensionSchema vector 类型和运算符所在的 PostgreSQL schema。
 * @param fields 集合声明的过滤字段名，按原顺序映射列和返回值。
 * @param operation 已通过校验的操作。
 * @returns SQL 文本与按占位符顺序排列的参数。
 */
export function compileOperation(
  schemaName: string,
  extensionSchema: string,
  fields: readonly string[],
  operation: VectorOperation,
): CompiledOperation {
  const table = qualifiedName(schemaName, operation.collection)
  const vectorType = qualifiedName(extensionSchema, "vector")
  const fieldColumns = fields.map(quoteIdentifier)

  switch (operation.type) {
    case "upsert":
    case "upsertMany": {
      const records = operation.type === "upsert" ? [operation.value] : operation.values
      const columns = ["id", "embedding", "payload"].map(quoteIdentifier).concat(fieldColumns)
      const values: unknown[] = []
      const rows = records.map(({ id, vector, fields: fieldValues, payload }) => {
        const offset = values.length
        values.push(
          id,
          encodeVector(vector),
          payload === undefined ? null : JSON.stringify(payload),
          ...fields.map((field) => fieldValues[field]),
        )
        const placeholders = [
          `$${offset + 1}`,
          `$${offset + 2}::${vectorType}`,
          `$${offset + 3}::pg_catalog.jsonb`,
          ...fields.map((_, index) => `$${offset + index + 4}`),
        ]
        return `(${placeholders.join(", ")})`
      })
      // 同 ID 重写整条记录，包括把省略的 payload 清为 SQL NULL。
      const assignments = columns.slice(1).map((column) => `${column} = EXCLUDED.${column}`)
      return {
        text: `INSERT INTO ${table} (${columns.join(", ")})
               VALUES ${rows.join(", ")}
               ON CONFLICT ("id") DO UPDATE SET ${assignments.join(", ")}`,
        values,
      }
    }
    case "get":
      return {
        text: `SELECT ${projection(fieldColumns)}, "embedding"::pg_catalog.text AS "vector"
                 FROM ${table} WHERE "id" = $1`,
        values: [operation.id],
      }
    case "delete":
      return { text: `DELETE FROM ${table} WHERE "id" = $1`, values: [operation.id] }
    case "deleteMany":
      return {
        text: `DELETE FROM ${table} WHERE "id" = ANY($1::pg_catalog.text[])`,
        values: [operation.ids],
      }
    case "search": {
      const distance = `"embedding" OPERATOR(${quoteIdentifier(extensionSchema)}.<=>) $1::${vectorType}`
      const values: unknown[] = [encodeVector(operation.vector)]
      const filter = operation.where
      const conditions =
        filter === undefined ? [] : filter.type === "and" ? filter.conditions : [filter]
      const predicates = conditions.map(({ field, value }) => {
        values.push(value)
        return `${quoteIdentifier(field)} = $${values.length}`
      })
      const where = predicates.length === 0 ? "" : ` WHERE ${predicates.join(" AND ")}`
      values.push(operation.limit)
      // + 0 保留距离顺序，同时阻止 PostgreSQL 将排序替换为近似向量索引扫描。
      return {
        text: `SELECT ${projection(fieldColumns)}, ${distance} AS "distance"
                 FROM ${table}${where}
                 ORDER BY (${distance}) + 0, "id" COLLATE pg_catalog."C"
                 LIMIT $${values.length}`,
        values,
      }
    }
  }
}

/** 提前编译整个操作，分块写入时由调用方在同一事务内执行所有 SQL。 */
export function compileStatements(
  schemaName: string,
  extensionSchema: string,
  fields: readonly string[],
  operation: VectorOperation,
): CompiledOperation[] {
  if (operation.type !== "upsertMany") {
    return [compileOperation(schemaName, extensionSchema, fields, operation)]
  }
  const rowsPerStatement = Math.min(
    MAX_UPSERT_ROWS_PER_STATEMENT,
    Math.floor(MAX_BIND_PARAMETERS / (fields.length + 3)),
  )
  const statements: CompiledOperation[] = []
  for (let offset = 0; offset < operation.values.length; offset += rowsPerStatement) {
    const values = operation.values.slice(offset, offset + rowsPerStatement)
    statements.push(compileOperation(schemaName, extensionSchema, fields, { ...operation, values }))
  }
  return statements
}

/** 将查询结果整理为协议形状，检索结果只携带距离与记录摘要。 */
export function mapResult(
  operation: VectorOperation,
  fields: readonly string[],
  result: Pick<QueryResult<ResultRow>, "rowCount" | "rows">,
): VectorResult {
  switch (operation.type) {
    case "upsert":
      if (result.rowCount !== 1) {
        throw new VectorError("invalid-operation", "PostgreSQL 未确认向量记录写入")
      }
      return { id: operation.value.id }
    case "upsertMany":
      if (result.rowCount !== operation.values.length) {
        throw new VectorError("invalid-operation", "PostgreSQL 未确认整批向量记录写入")
      }
      return { ids: operation.values.map(({ id }) => id) }
    case "get": {
      const row = result.rows[0]
      return {
        record:
          row === undefined
            ? undefined
            : { ...recordSummary(row, fields), vector: JSON.parse(row.vector) as number[] },
      }
    }
    case "delete":
      return { affectedRows: result.rowCount === 1 ? 1 : 0 }
    case "deleteMany":
      return { affectedRows: result.rowCount ?? 0 }
    case "search":
      return {
        matches: result.rows.map((row) => {
          if (!Number.isFinite(row.distance)) {
            throw new VectorError("invalid-value", `记录 '${row.id}' 无法计算有限的余弦距离`)
          }
          return { ...recordSummary(row, fields), distance: row.distance }
        }),
      }
  }
}

function projection(fieldColumns: readonly string[]): string {
  return [
    quoteIdentifier("id"),
    quoteIdentifier("payload"),
    ...fieldColumns.map((column, index) => `${column} AS "field_${index}"`),
  ].join(", ")
}

function recordSummary(row: ResultRow, fields: readonly string[]): Omit<VectorRecord, "vector"> {
  return {
    id: row.id,
    fields: Object.fromEntries(
      fields.map((field, index) => [field, row[`field_${index}`] as VectorFieldValue]),
    ),
    ...(row.payload === null ? {} : { payload: row.payload }),
  }
}

/** pgvector 使用单精度浮点数，转换后仍须有限且保留至少一个非零分量。 */
function encodeVector(vector: readonly number[]): string {
  let hasNonzeroValue = false
  for (const value of vector) {
    const float = Math.fround(value)
    if (!Number.isFinite(float)) {
      throw new VectorError("invalid-value", "向量分量超出 pgvector 单精度浮点范围")
    }
    hasNonzeroValue ||= float !== 0
  }
  if (!hasNonzeroValue) {
    throw new VectorError("invalid-value", "向量转换为单精度后不能是全零向量")
  }
  return JSON.stringify(vector)
}
