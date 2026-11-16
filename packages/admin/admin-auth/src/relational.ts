import type { RelationalAdapter, RelationalRecord } from "toy-storage-relational"
import { AdminAuthError } from "./error.js"
import { isAdminRole } from "./permissions.js"
import { adminAuthRelationalSchema } from "./schema.js"
import type { AdminProfile, AdminRole } from "./types.js"

/** 除字段、主键外还核对唯一索引声明，避免静默丢失安全约束。 */
export function assertAdminAuthSchema(adapter: RelationalAdapter): void {
  if (adapter.capabilities?.transactions !== true) {
    throw new AdminAuthError("transactions-required", "管理员认证存储必须支持事务")
  }
  for (const [name, required] of Object.entries(adminAuthRelationalSchema.tables)) {
    const actual = adapter.schema.tables[name]
    if (actual?.primaryKey !== required.primaryKey) {
      throw new AdminAuthError("schema-mismatch", `缺少正确的 '${name}' 表或主键`)
    }
    for (const [field, expected] of Object.entries(required.columns)) {
      const column = actual.columns[field]
      if (
        column?.type !== expected.type ||
        (column.nullable === true) !== ("nullable" in expected && expected.nullable === true)
      ) {
        throw new AdminAuthError("schema-mismatch", `字段 '${name}.${field}' 与定义不一致`)
      }
    }
    if ("indexes" in required) {
      for (const index of required.indexes) {
        if (
          "unique" in index &&
          index.unique &&
          !actual.indexes?.some(
            (candidate) =>
              candidate.unique === true &&
              candidate.fields.length === index.fields.length &&
              candidate.fields.every((field, i) => field === index.fields[i]),
          )
        ) {
          throw new AdminAuthError("schema-mismatch", `缺少 '${name}' 的唯一索引 '${index.name}'`)
        }
      }
    }
  }
}

export function stringField(row: RelationalRecord, field: string): string {
  const value = row[field]
  if (typeof value !== "string") {
    throw new AdminAuthError("schema-mismatch", `存储字段 '${field}' 不是字符串`)
  }
  return value
}

export function versionOf(row: RelationalRecord): number {
  const value = row.security_version
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new AdminAuthError("schema-mismatch", "存储安全版本不合法")
  }
  return value
}

export function roleOf(row: RelationalRecord): AdminRole {
  if (!isAdminRole(row.role)) {
    throw new AdminAuthError(
      "schema-mismatch",
      "管理员角色缺失或不合法，请检查 schema 与历史数据迁移",
    )
  }
  return row.role
}

export function profile(row: RelationalRecord): AdminProfile {
  if (typeof row.enabled !== "boolean") {
    throw new AdminAuthError("schema-mismatch", "管理员启用状态不合法")
  }
  return {
    adminId: stringField(row, "admin_id"),
    loginName: stringField(row, "login_name"),
    displayName: stringField(row, "display_name"),
    role: roleOf(row),
    enabled: row.enabled,
    createdAt: stringField(row, "created_at"),
    updatedAt: stringField(row, "updated_at"),
    passwordChangedAt: stringField(row, "password_changed_at"),
  }
}
