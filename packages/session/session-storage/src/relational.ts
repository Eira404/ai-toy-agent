import type { InsertOperation, RelationalAdapter, RelationalRecord } from "toy-storage-relational"
import { SessionStorageError } from "./error.js"
import { sessionRelationalSchema } from "./schema.js"
import type { EventRecord, SessionRecord, TurnRecord } from "./types.js"

/** 检查命名 adapter 是否配置了本包需要的三张表及约束。 */
export function assertSessionSchema(adapter: RelationalAdapter): void {
  for (const [name, required] of Object.entries(sessionRelationalSchema.tables)) {
    const actual = adapter.schema.tables[name]
    if (actual?.primaryKey !== required.primaryKey) {
      throw new SessionStorageError("schema-mismatch", `数据源缺少正确的 '${name}' 表或主键`)
    }
    for (const [field, expected] of Object.entries(required.columns)) {
      const column = actual.columns[field]
      if (
        column?.type !== expected.type ||
        (column.nullable === true) !== ("nullable" in expected && expected.nullable === true)
      ) {
        throw new SessionStorageError(
          "schema-mismatch",
          `数据源字段 '${name}.${field}' 与 Session 定义不一致`,
        )
      }
    }
    for (const index of required.indexes) {
      const found = actual.indexes?.some(
        (candidate) =>
          candidate.name === index.name &&
          (candidate.unique === true) === ("unique" in index && index.unique === true) &&
          candidate.fields.length === index.fields.length &&
          candidate.fields.every((field, position) => field === index.fields[position]),
      )
      if (!found) {
        throw new SessionStorageError(
          "schema-mismatch",
          `数据源缺少 '${name}.${index.name}' 索引定义`,
        )
      }
    }
  }
}

/** 将 Session 领域对象转换为关系型记录。 */
export function sessionRow(session: SessionRecord): RelationalRecord {
  return {
    session_id: session.sessionId,
    user_id: session.userId,
    device_id: session.deviceId,
    status: session.status,
    payload: session.payload,
    version: session.version,
    created_at: session.createdAt,
    closing_at: session.closingAt,
    closed_at: session.closedAt,
  }
}

/** 将 Turn 领域对象转换为关系型记录。 */
export function turnRow(turn: TurnRecord): RelationalRecord {
  return {
    turn_id: turn.turnId,
    session_id: turn.sessionId,
    turn_no: turn.turnNo,
    started_at: turn.startedAt,
  }
}

/** 将 Event 转换为现有关系型 insert 操作，供写入队列直接执行。 */
export function eventInsert(event: EventRecord): InsertOperation {
  return {
    type: "insert",
    table: "toy_session_events",
    value: {
      event_id: event.eventId,
      session_id: event.sessionId,
      turn_id: event.turnId,
      sequence: event.sequence,
      event_type: event.eventType,
      payload: event.payload,
      version: event.version,
      occurred_at: event.occurredAt,
    },
  }
}

/** 将 adapter 返回的 Session 行还原成公开对象。 */
export function sessionFromRow(row: RelationalRecord): SessionRecord {
  const status = row.status
  if (status !== "active" && status !== "closing" && status !== "closed") {
    throw new SessionStorageError("schema-mismatch", "数据库包含未知 Session 状态")
  }
  return {
    sessionId: stringField(row, "session_id"),
    userId: stringField(row, "user_id"),
    deviceId: stringField(row, "device_id"),
    status,
    payload: jsonField(row, "payload"),
    version: numberField(row, "version"),
    createdAt: stringField(row, "created_at"),
    closingAt: nullableStringField(row, "closing_at"),
    closedAt: nullableStringField(row, "closed_at"),
  }
}

/** 将 adapter 返回的 Turn 行还原成公开对象。 */
export function turnFromRow(row: RelationalRecord): TurnRecord {
  return {
    turnId: stringField(row, "turn_id"),
    sessionId: stringField(row, "session_id"),
    turnNo: numberField(row, "turn_no"),
    startedAt: stringField(row, "started_at"),
  }
}

/** 将 adapter 返回的 Event 行还原成公开对象。 */
export function eventFromRow(row: RelationalRecord): EventRecord {
  return {
    eventId: stringField(row, "event_id"),
    sessionId: stringField(row, "session_id"),
    turnId: stringField(row, "turn_id"),
    sequence: numberField(row, "sequence"),
    eventType: stringField(row, "event_type"),
    payload: jsonField(row, "payload"),
    version: numberField(row, "version"),
    occurredAt: stringField(row, "occurred_at"),
  }
}

function stringField(row: RelationalRecord, field: string): string {
  const value = row[field]
  if (typeof value !== "string") {
    throw new SessionStorageError("schema-mismatch", `数据库字段 '${field}' 不是字符串`)
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

function numberField(row: RelationalRecord, field: string): number {
  const value = row[field]
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new SessionStorageError("schema-mismatch", `数据库字段 '${field}' 不是安全整数`)
  }
  return value
}

function jsonField(row: RelationalRecord, field: string): Exclude<RelationalRecord[string], null> {
  const value = row[field]
  if (value === undefined || value === null) {
    throw new SessionStorageError("schema-mismatch", `数据库字段 '${field}' 缺失或为 null`)
  }
  return value
}
