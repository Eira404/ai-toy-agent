import type { RelationalAdapter, RelationalRecord } from "toy-storage-relational"
import { MemoryFeedbackError } from "./error.js"
import { feedbackRelationalSchema, FEEDBACK_TABLE } from "./schema.js"
import type { FeedbackOutcome, FeedbackType, ValueUnitType } from "./types.js"

const UNIT_TYPES: readonly ValueUnitType[] = ["overview", "detail"]

const FEEDBACK_TYPES: readonly FeedbackType[] = [
  "no_user_signal",
  "confirmed",
  "supplemented",
  "follow_up",
  "corrected",
  "irrelevant",
  "uncertain",
]

/** 检查命名 adapter 是否配置了本包需要的表、字段与索引。 */
export function assertFeedbackSchema(adapter: RelationalAdapter): void {
  for (const [name, required] of Object.entries(feedbackRelationalSchema.tables)) {
    const actual = adapter.schema.tables[name]
    if (actual?.primaryKey !== required.primaryKey) {
      throw new MemoryFeedbackError("schema-mismatch", `数据源缺少正确的 '${name}' 表或主键`)
    }
    for (const [field, expected] of Object.entries(required.columns)) {
      const column = actual.columns[field]
      if (
        column?.type !== expected.type ||
        (column.nullable === true) !== ("nullable" in expected && expected.nullable === true)
      ) {
        throw new MemoryFeedbackError(
          "schema-mismatch",
          `数据源字段 '${name}.${field}' 与记忆反馈定义不一致`,
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
        throw new MemoryFeedbackError(
          "schema-mismatch",
          `数据源缺少 '${name}.${index.name}' 索引定义`,
        )
      }
    }
  }
}

/** 将反馈领域对象转换为关系型记录。 */
export function feedbackRow(outcome: FeedbackOutcome): RelationalRecord {
  return {
    feedback_id: outcome.feedbackId,
    user_id: outcome.userId,
    memory_space_id: outcome.memorySpaceId,
    session_id: outcome.sessionId,
    unit_type: outcome.unitType,
    unit_id: outcome.unitId,
    block_id: outcome.blockId,
    feedback_type: outcome.feedbackType,
    evidence_turn_nos: outcome.evidenceTurnNos,
    recall_turn_nos: outcome.recallTurnNos,
    judgement_data: outcome.judgementData,
    judgement_version: outcome.judgementVersion,
    consumed_batch_id: outcome.consumedBatchId,
    consumed_at: outcome.consumedAt,
    created_at: outcome.createdAt,
    updated_at: outcome.updatedAt,
  }
}

/** 将 adapter 返回的反馈行还原成公开对象。 */
export function feedbackFromRow(row: RelationalRecord): FeedbackOutcome {
  return {
    feedbackId: stringField(row, "feedback_id"),
    userId: stringField(row, "user_id"),
    memorySpaceId: stringField(row, "memory_space_id"),
    sessionId: stringField(row, "session_id"),
    unitType: unitTypeField(row, "unit_type"),
    unitId: stringField(row, "unit_id"),
    blockId: stringField(row, "block_id"),
    feedbackType: feedbackTypeField(row, "feedback_type"),
    evidenceTurnNos: numberArrayField(row, "evidence_turn_nos"),
    recallTurnNos: numberArrayField(row, "recall_turn_nos"),
    judgementData: jsonField(row, "judgement_data"),
    judgementVersion: integerField(row, "judgement_version"),
    consumedBatchId: nullableStringField(row, "consumed_batch_id"),
    consumedAt: nullableStringField(row, "consumed_at"),
    createdAt: stringField(row, "created_at"),
    updatedAt: stringField(row, "updated_at"),
  }
}

function stringField(row: RelationalRecord, field: string): string {
  const value = row[field]
  if (typeof value !== "string") {
    throw new MemoryFeedbackError("schema-mismatch", `数据库字段 '${field}' 不是字符串`)
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

function integerField(row: RelationalRecord, field: string): number {
  const value = row[field]
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new MemoryFeedbackError("schema-mismatch", `数据库字段 '${field}' 不是安全整数`)
  }
  return value
}

function jsonField(row: RelationalRecord, field: string): RelationalRecord[string] {
  const value = row[field]
  if (value === undefined || value === null) {
    throw new MemoryFeedbackError("schema-mismatch", `数据库字段 '${field}' 缺失或为 null`)
  }
  return value
}

function numberArrayField(row: RelationalRecord, field: string): readonly number[] {
  const value = row[field]
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== "number" || !Number.isSafeInteger(item))
  ) {
    throw new MemoryFeedbackError("schema-mismatch", `数据库字段 '${field}' 不是整数数组`)
  }
  return value as number[]
}

function unitTypeField(row: RelationalRecord, field: string): ValueUnitType {
  const value = stringField(row, field)
  if (!UNIT_TYPES.includes(value as ValueUnitType)) {
    throw new MemoryFeedbackError("schema-mismatch", `数据库字段 '${field}' 包含未知单元类型`)
  }
  return value as ValueUnitType
}

function feedbackTypeField(row: RelationalRecord, field: string): FeedbackType {
  const value = stringField(row, field)
  if (!FEEDBACK_TYPES.includes(value as FeedbackType)) {
    throw new MemoryFeedbackError("schema-mismatch", `数据库字段 '${field}' 包含未知反馈类型`)
  }
  return value as FeedbackType
}

export { FEEDBACK_TABLE }
