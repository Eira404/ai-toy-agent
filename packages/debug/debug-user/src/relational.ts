import type {
  JsonValue,
  RelationalAdapter,
  RelationalRecord,
  RelationalTableDefinition,
} from "toy-storage-relational"
import { DebugUserError } from "./error.js"
import { USERS_TABLE, usersRelationalSchema } from "./schema.js"
import type { UserRecord } from "./types.js"

/** 检查命名 adapter 是否配置了本包需要的用户表及约束。 */
export function assertUsersSchema(adapter: RelationalAdapter): void {
  const required = usersRelationalSchema.tables[USERS_TABLE]
  const actual = adapter.schema.tables[USERS_TABLE]
  if (actual?.primaryKey !== required.primaryKey) {
    throw new DebugUserError("schema-mismatch", `数据源缺少正确的 '${USERS_TABLE}' 表或主键`)
  }
  for (const [field, expected] of Object.entries(required.columns)) {
    const column = actual.columns[field]
    if (
      column?.type !== expected.type ||
      (column.nullable === true) !== ("nullable" in expected && expected.nullable === true)
    ) {
      throw new DebugUserError("schema-mismatch", `数据源字段 '${USERS_TABLE}.${field}' 与定义不一致`)
    }
  }
}

/** 将 User 领域对象转换为关系型记录。 */
export function userRow(user: UserRecord): RelationalRecord {
  return {
    user_id: user.userId,
    display_name: user.displayName,
    note: user.note,
    payload: user.payload,
    created_at: user.createdAt,
    updated_at: user.updatedAt,
  }
}

/** 将 adapter 返回的行还原成公开对象。 */
export function userFromRow(row: RelationalRecord): UserRecord {
  return {
    userId: stringField(row, "user_id"),
    displayName: nullableStringField(row, "display_name"),
    note: nullableStringField(row, "note"),
    payload: jsonField(row, "payload"),
    createdAt: stringField(row, "created_at"),
    updatedAt: stringField(row, "updated_at"),
  }
}

function stringField(row: RelationalRecord, field: string): string {
  const value = row[field]
  if (typeof value !== "string") {
    throw new DebugUserError("schema-mismatch", `数据库字段 '${field}' 不是字符串`)
  }
  return value
}

function nullableStringField(row: RelationalRecord, field: string): string | null {
  const value = row[field]
  if (value === null) {
    return null
  }
  return stringField(row, field)
}

function jsonField(row: RelationalRecord, field: string): JsonValue {
  const value = row[field]
  if (value === undefined) {
    throw new DebugUserError("schema-mismatch", `数据库字段 '${field}' 缺失`)
  }
  return value
}
