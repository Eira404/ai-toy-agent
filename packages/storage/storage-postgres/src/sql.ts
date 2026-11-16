import { RelationalError, type RelationalTableDefinition } from "toy-storage-relational"

/** Schema 已经过协议插件校验，但仍对每个动态 SQL 标识符执行独立转义。 */
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

/** PostgreSQL 字段类型映射。datetime 在读出时统一转换为 ISO 字符串。 */
export function columnSql(column: RelationalTableDefinition["columns"][string]): string {
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
