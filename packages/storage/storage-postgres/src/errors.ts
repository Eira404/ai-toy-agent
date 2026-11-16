import { RelationalError } from "toy-storage-relational"

/** 将 PostgreSQL 驱动错误转换为跨 adapter 的稳定错误。 */
export function normalizePostgresError(error: unknown): RelationalError {
  if (error instanceof RelationalError) {
    return error
  }
  const code = (error as { code?: unknown } | null)?.code
  switch (code) {
    case "23505":
      return new RelationalError("duplicate-key", "PostgreSQL 唯一约束冲突", { cause: error })
    case "23502":
    case "23503":
    case "23514":
      return new RelationalError("constraint-violation", "PostgreSQL 约束校验失败", {
        cause: error,
      })
    case "40001":
    case "40P01":
      return new RelationalError("transaction-conflict", "PostgreSQL 事务发生冲突", {
        cause: error,
      })
    case "57014":
      return new RelationalError("timeout", "PostgreSQL 查询超时或被取消", { cause: error })
    case "42P01":
      return new RelationalError("table-not-found", "PostgreSQL 表不存在", { cause: error })
    case "42703":
      return new RelationalError("invalid-field", "PostgreSQL 字段不存在", { cause: error })
    case "22P02":
    case "22003":
      return new RelationalError("invalid-value", "PostgreSQL 无法接受该字段值", { cause: error })
    default:
      return new RelationalError("connection-failed", "PostgreSQL 操作失败", { cause: error })
  }
}
