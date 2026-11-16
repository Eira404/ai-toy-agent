import type { RelationalRecord } from "toy-storage-relational"
import type { FastRecord } from "./types.js"

/**
 * 关系表行（snake_case）与公共类型（camelCase）之间的映射。
 *
 * 行由 adapter 返回或写入，字段名与 `schema.ts` 保持一致；对外只暴露
 * camelCase 的 `FastRecord`，避免上层接触数据库命名。
 */

/** `FastRecord` → 关系表 `toy_memory_fast_records` 的插入/更新行。 */
export function recordToRow(record: FastRecord): RelationalRecord {
  return {
    fast_id: record.fastId,
    write_id: record.writeId,
    user_id: record.userId,
    memory_space_id: record.memorySpaceId,
    session_id: record.sessionId,
    turn_id: record.turnId,
    created_at: record.createdAt,
    title: record.title,
    title_key: record.titleKey,
    summary: record.summary,
    body: record.body,
    consumed_batch_id: record.consumedBatchId,
    consumed_at: record.consumedAt,
  }
}

/** 关系表行 → `FastRecord`；`consumed_*` 可空字段按 null 还原。 */
export function recordFromRow(row: RelationalRecord): FastRecord {
  return {
    fastId: asString(row, "fast_id"),
    writeId: asString(row, "write_id"),
    userId: asString(row, "user_id"),
    memorySpaceId: asString(row, "memory_space_id"),
    sessionId: asString(row, "session_id"),
    turnId: asString(row, "turn_id"),
    createdAt: asString(row, "created_at"),
    title: asString(row, "title"),
    titleKey: asString(row, "title_key"),
    summary: asString(row, "summary"),
    body: asString(row, "body"),
    consumedBatchId: row.consumed_batch_id === null ? null : asString(row, "consumed_batch_id"),
    consumedAt: row.consumed_at === null ? null : asString(row, "consumed_at"),
  }
}

function asString(row: RelationalRecord, field: string): string {
  const value = row[field]
  if (typeof value !== "string") {
    throw new Error(`关系表字段 '${field}' 不是字符串`)
  }
  return value
}
