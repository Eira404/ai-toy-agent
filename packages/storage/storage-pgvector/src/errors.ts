import { VectorError } from "toy-storage-vector"

const CONNECTION_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EPIPE",
  "EAI_AGAIN",
  "ENOTFOUND",
  "EACCES",
  "57P01",
  "57P02",
  "57P03",
  "53300",
])

/** 将数据库异常映射到稳定错误码，只有确认未提交的临时失败可重试。 */
export function normalizePgError(error: unknown, connecting = false): VectorError {
  if (error instanceof VectorError) {
    return error
  }
  const driverCode = (error as { code?: unknown } | null | undefined)?.code
  const code = typeof driverCode === "string" ? driverCode : ""
  const cause = { cause: error }
  if (
    CONNECTION_CODES.has(code) ||
    code.startsWith("08") ||
    (connecting && code === "") ||
    (error instanceof Error && error.message.startsWith("Connection terminated"))
  ) {
    return new VectorError("connection-failed", "pgvector 数据库连接失败", cause)
  }
  if (code === "57014") {
    return new VectorError("timeout", "pgvector 语句超时或被数据库取消", cause)
  }
  if (code === "42P01") {
    return new VectorError("collection-not-found", "pgvector 集合表不存在", cause)
  }
  if (code === "42703") {
    return new VectorError("invalid-field", "pgvector 集合字段不存在", cause)
  }
  if (code.startsWith("22")) {
    return new VectorError("invalid-value", "pgvector 无法接受该字段值", cause)
  }
  return new VectorError("invalid-operation", "PostgreSQL 拒绝执行 pgvector 操作", cause)
}
