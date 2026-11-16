import { Buffer } from "node:buffer"
import { VectorError, type VectorFieldType } from "toy-storage-vector"

/** 使用系统类型名，以便 DDL 与启动时的目录校验共用类型映射。 */
export const FILTER_COLUMN_TYPES: Readonly<Record<VectorFieldType, string>> = {
  string: "text",
  number: "float8",
  boolean: "bool",
}

/** 引用配置或系统目录中的标识符，拒绝会被 PostgreSQL 截断的名称。 */
export function quoteIdentifier(value: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes("\0") ||
    Buffer.byteLength(value, "utf8") > 63
  ) {
    throw new VectorError("invalid-schema", "PostgreSQL 标识符必须是 1 到 63 字节的有效名称")
  }
  return `"${value.replaceAll(/"/g, (quote) => quote.repeat(2))}"`
}

/** 将表和类型限定在它们各自的 schema，避免依赖连接的 search_path。 */
export function qualifiedName(schema: string, name: string): string {
  return `${quoteIdentifier(schema)}.${quoteIdentifier(name)}`
}
