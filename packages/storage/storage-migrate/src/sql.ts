import { RelationalError, type RelationalColumnDefinition } from "toy-storage-relational"

/** 对动态 SQL 标识符做独立转义，避免注入。 */
export function quoteIdentifier(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new RelationalError("invalid-schema", `非法 SQL 标识符 '${value}'`)
  }
  return `"${value}"`
}

/** 生成 schema 限定的完整表名。 */
export function qualifiedTable(schemaName: string, table: string): string {
  return `${quoteIdentifier(schemaName)}.${quoteIdentifier(table)}`
}

/** 逻辑类型 → PostgreSQL 类型。 */
export function columnSql(column: RelationalColumnDefinition): string {
  switch (column.type) {
    case "string":
      return "TEXT"
    case "integer":
      return "BIGINT"
    case "number":
      return "DOUBLE PRECISION"
    case "boolean":
      return "BOOLEAN"
    case "datetime":
      return "TIMESTAMPTZ"
    case "json":
      return "JSONB"
  }
}

/**
 * 把 `information_schema.columns.data_type` 归一化到与 `columnSql` 可比对的形式。
 *
 * 例如 PG 的 `timestamp with time zone` → `timestamptz`，与 `columnSql` 的小写结果对齐。
 */
export function normalizePgType(dataType: string): string {
  const value = dataType.trim().toLowerCase()
  switch (value) {
    case "timestamp with time zone":
      return "timestamptz"
    case "timestamp without time zone":
      return "timestamp"
    case "character varying":
      return "varchar"
    case "character":
      return "char"
    default:
      return value
  }
}
