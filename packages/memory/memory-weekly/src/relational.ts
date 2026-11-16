import type {
  JsonValue,
  RelationalAdapter,
  RelationalRecord,
} from "toy-storage-relational"
import { WeeklyMemoryError } from "./error.js"
import { weeklyRelationalSchema } from "./schema.js"
import type {
  WeeklyBatch,
  WeeklyBatchStatus,
  WeeklyCheckpoint,
  WeeklyCheckpointStage,
  WeeklyOp,
  WeeklyStructureOp,
} from "./types.js"

const BATCH_STATUSES: readonly WeeklyBatchStatus[] = [
  "waiting_gate",
  "running",
  "committing",
  "reconciling",
  "succeeded",
  "failed",
  "abandoned",
]

const STRUCTURE_OPS: readonly WeeklyStructureOp[] = ["SPLIT", "RECLASSIFY", "MERGE", "RENAME"]

/** 检查命名 adapter 是否配置了本包需要的表、字段与索引。 */
export function assertWeeklySchema(adapter: RelationalAdapter): void {
  for (const [name, required] of Object.entries(weeklyRelationalSchema.tables)) {
    const actual = adapter.schema.tables[name]
    if (actual?.primaryKey !== required.primaryKey) {
      throw new WeeklyMemoryError("schema-mismatch", `数据源缺少正确的 '${name}' 表或主键`)
    }
    for (const [field, expected] of Object.entries(required.columns)) {
      const column = actual.columns[field]
      if (column === undefined) {
        throw new WeeklyMemoryError(
          "schema-mismatch",
          `数据源字段 '${name}.${field}' 与 Weekly 定义不一致`,
        )
      }
      const nullable = "nullable" in expected && expected.nullable === true
      if (column.type !== expected.type || (column.nullable === true) !== nullable) {
        throw new WeeklyMemoryError(
          "schema-mismatch",
          `数据源字段 '${name}.${field}' 与 Weekly 定义不一致`,
        )
      }
    }
    for (const index of required.indexes ?? []) {
      const found = actual.indexes?.some(
        (candidate) =>
          candidate.name === index.name &&
          (candidate.unique === true) === ("unique" in index && index.unique === true) &&
          candidate.fields.length === index.fields.length &&
          candidate.fields.every((field, position) => field === index.fields[position]),
      )
      if (!found) {
        throw new WeeklyMemoryError("schema-mismatch", `数据源缺少 '${name}.${index.name}' 索引定义`)
      }
    }
  }
}

// ============ 行映射（snake_case 表列 ↔ camelCase 领域对象） ============

export function weeklyBatchRow(batch: WeeklyBatch): RelationalRecord {
  return {
    weekly_batch_id: batch.weeklyBatchId,
    user_id: batch.userId,
    memory_space_id: batch.memorySpaceId,
    status: batch.status,
    checkpoint_stage: batch.checkpointStage,
    gate_credential: batch.gateCredential,
    pre_daily_batch_id: batch.preDailyBatchId,
    pre_daily_ran: batch.preDailyRan,
    attempt_count: batch.attemptCount,
    last_error: batch.lastError,
    started_at: batch.startedAt,
    committed_at: batch.committedAt,
    finished_at: batch.finishedAt,
    created_at: batch.createdAt,
    updated_at: batch.updatedAt,
  }
}

export function weeklyBatchFromRow(row: RelationalRecord): WeeklyBatch {
  return {
    weeklyBatchId: stringField(row, "weekly_batch_id"),
    userId: stringField(row, "user_id"),
    memorySpaceId: stringField(row, "memory_space_id"),
    status: enumField(row, "status", BATCH_STATUSES),
    checkpointStage: stageField(row, "checkpoint_stage"),
    gateCredential: nullableStringField(row, "gate_credential"),
    preDailyBatchId: nullableStringField(row, "pre_daily_batch_id"),
    preDailyRan: boolField(row, "pre_daily_ran"),
    attemptCount: intField(row, "attempt_count"),
    lastError: nullableStringField(row, "last_error"),
    startedAt: nullableStringField(row, "started_at"),
    committedAt: nullableStringField(row, "committed_at"),
    finishedAt: nullableStringField(row, "finished_at"),
    createdAt: stringField(row, "created_at"),
    updatedAt: stringField(row, "updated_at"),
  }
}

export function weeklyCheckpointRow(checkpoint: WeeklyCheckpoint): RelationalRecord {
  return {
    checkpoint_id: checkpoint.checkpointId,
    batch_id: checkpoint.batchId,
    stage: checkpoint.stage,
    payload: checkpoint.payload,
    created_at: checkpoint.createdAt,
  }
}

export function weeklyCheckpointFromRow(row: RelationalRecord): WeeklyCheckpoint {
  return {
    checkpointId: stringField(row, "checkpoint_id"),
    batchId: stringField(row, "batch_id"),
    stage: stageField(row, "stage"),
    payload: jsonField(row, "payload"),
    createdAt: stringField(row, "created_at"),
  }
}

export function weeklyOpRow(op: WeeklyOp): RelationalRecord {
  return {
    op_id: op.opId,
    batch_id: op.batchId,
    memory_space_id: op.memorySpaceId,
    block_id: op.blockId,
    op: op.op,
    related_block_ids: op.relatedBlockIds,
    created_at: op.createdAt,
  }
}

export function weeklyOpFromRow(row: RelationalRecord): WeeklyOp {
  return {
    opId: stringField(row, "op_id"),
    batchId: stringField(row, "batch_id"),
    memorySpaceId: stringField(row, "memory_space_id"),
    blockId: stringField(row, "block_id"),
    op: enumField(row, "op", STRUCTURE_OPS),
    relatedBlockIds: jsonField(row, "related_block_ids"),
    createdAt: stringField(row, "created_at"),
  }
}

// ============ 字段读取辅助 ============

function stringField(row: RelationalRecord, field: string): string {
  const value = row[field]
  if (typeof value !== "string") {
    throw new WeeklyMemoryError("schema-mismatch", `数据库字段 '${field}' 不是字符串`)
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

function intField(row: RelationalRecord, field: string): number {
  const value = row[field]
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new WeeklyMemoryError("schema-mismatch", `数据库字段 '${field}' 不是安全整数`)
  }
  return value
}

function boolField(row: RelationalRecord, field: string): boolean {
  const value = row[field]
  if (typeof value !== "boolean") {
    throw new WeeklyMemoryError("schema-mismatch", `数据库字段 '${field}' 不是布尔值`)
  }
  return value
}

function jsonField(row: RelationalRecord, field: string): JsonValue {
  const value = row[field]
  if (value === undefined || value === null) {
    throw new WeeklyMemoryError("schema-mismatch", `数据库字段 '${field}' 缺失或为 null`)
  }
  return value
}

function stageField(row: RelationalRecord, field: string): WeeklyCheckpointStage {
  const value = intField(row, field)
  if (value < 0 || value > 7) {
    throw new WeeklyMemoryError("schema-mismatch", `数据库字段 '${field}' 不是合法阶段编号`)
  }
  return value as WeeklyCheckpointStage
}

function enumField<T extends string>(
  row: RelationalRecord,
  field: string,
  allowed: readonly T[],
): T {
  const value = stringField(row, field)
  if (!allowed.includes(value as T)) {
    throw new WeeklyMemoryError("schema-mismatch", `数据库字段 '${field}' 包含未知值 '${value}'`)
  }
  return value as T
}
