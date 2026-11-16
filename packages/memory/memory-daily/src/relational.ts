import type {
  RelationalAdapter,
  RelationalRecord,
  JsonValue,
} from "toy-storage-relational"
import { DailyMemoryError } from "./error.js"
import { dailyRelationalSchema } from "./schema.js"
import type {
  CheckpointStage,
  DailyAudit,
  DailyAuditResult,
  DailyBatch,
  DailyBatchStatus,
  DailyCheckpoint,
  DailySpaceState,
} from "./types.js"

const BATCH_STATUSES: readonly DailyBatchStatus[] = [
  "waiting_gate",
  "running",
  "committing",
  "reconciling",
  "succeeded",
  "failed",
  "abandoned",
]

const AUDIT_RESULTS: readonly DailyAuditResult[] = ["APPLY", "LOCAL_ABANDON"]

/**
 * 检查命名 adapter 是否配置了本包需要的表、字段与索引。
 *
 * 只核对表名、主键、字段类型与索引，不负责数据库迁移；由宿主持有本包
 * 导出的 Schema 并交给具体 adapter 创建结构。
 */
export function assertDailySchema(adapter: RelationalAdapter): void {
  for (const [name, required] of Object.entries(dailyRelationalSchema.tables)) {
    const actual = adapter.schema.tables[name]
    if (actual?.primaryKey !== required.primaryKey) {
      throw new DailyMemoryError("schema-mismatch", `数据源缺少正确的 '${name}' 表或主键`)
    }
    for (const [field, expected] of Object.entries(required.columns)) {
      const column = actual.columns[field]
      if (column === undefined) {
        throw new DailyMemoryError(
          "schema-mismatch",
          `数据源字段 '${name}.${field}' 与 Daily 定义不一致`,
        )
      }
      const nullable = "nullable" in expected && expected.nullable === true
      if (column.type !== expected.type || (column.nullable === true) !== nullable) {
        throw new DailyMemoryError(
          "schema-mismatch",
          `数据源字段 '${name}.${field}' 与 Daily 定义不一致`,
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
        throw new DailyMemoryError("schema-mismatch", `数据源缺少 '${name}.${index.name}' 索引定义`)
      }
    }
  }
}

// ============ 行映射（snake_case 表列 ↔ camelCase 领域对象） ============

/** 将批次领域对象转换为关系表行。 */
export function batchRow(batch: DailyBatch): RelationalRecord {
  return {
    batch_id: batch.batchId,
    user_id: batch.userId,
    memory_space_id: batch.memorySpaceId,
    status: batch.status,
    checkpoint_stage: batch.checkpointStage,
    gate_credential: batch.gateCredential,
    frozen_fast_count: batch.frozenFastCount,
    frozen_turn_count: batch.frozenTurnCount,
    decay_enabled: batch.decayEnabled,
    attempt_count: batch.attemptCount,
    last_error: batch.lastError,
    frozen_at: batch.frozenAt,
    started_at: batch.startedAt,
    committed_at: batch.committedAt,
    finished_at: batch.finishedAt,
    created_at: batch.createdAt,
    updated_at: batch.updatedAt,
  }
}

/** 将关系表行还原为批次领域对象。 */
export function batchFromRow(row: RelationalRecord): DailyBatch {
  return {
    batchId: stringField(row, "batch_id"),
    userId: stringField(row, "user_id"),
    memorySpaceId: stringField(row, "memory_space_id"),
    status: enumField(row, "status", BATCH_STATUSES),
    checkpointStage: stageField(row, "checkpoint_stage"),
    gateCredential: nullableStringField(row, "gate_credential"),
    frozenFastCount: intField(row, "frozen_fast_count"),
    frozenTurnCount: intField(row, "frozen_turn_count"),
    decayEnabled: boolField(row, "decay_enabled"),
    attemptCount: intField(row, "attempt_count"),
    lastError: nullableStringField(row, "last_error"),
    frozenAt: nullableStringField(row, "frozen_at"),
    startedAt: nullableStringField(row, "started_at"),
    committedAt: nullableStringField(row, "committed_at"),
    finishedAt: nullableStringField(row, "finished_at"),
    createdAt: stringField(row, "created_at"),
    updatedAt: stringField(row, "updated_at"),
  }
}

/** 将 checkpoint 领域对象转换为关系表行。 */
export function checkpointRow(checkpoint: DailyCheckpoint): RelationalRecord {
  return {
    checkpoint_id: checkpoint.checkpointId,
    batch_id: checkpoint.batchId,
    stage: checkpoint.stage,
    payload: checkpoint.payload,
    created_at: checkpoint.createdAt,
  }
}

/** 将关系表行还原为 checkpoint 领域对象。 */
export function checkpointFromRow(row: RelationalRecord): DailyCheckpoint {
  return {
    checkpointId: stringField(row, "checkpoint_id"),
    batchId: stringField(row, "batch_id"),
    stage: stageField(row, "stage"),
    payload: jsonField(row, "payload"),
    createdAt: stringField(row, "created_at"),
  }
}

/** 将审计领域对象转换为关系表行。 */
export function auditRow(audit: DailyAudit): RelationalRecord {
  return {
    audit_id: audit.auditId,
    batch_id: audit.batchId,
    memory_space_id: audit.memorySpaceId,
    target_block_id: audit.targetBlockId,
    result: audit.result,
    source_fast_ids: audit.sourceFastIds,
    created_at: audit.createdAt,
  }
}

/** 将关系表行还原为审计领域对象。 */
export function auditFromRow(row: RelationalRecord): DailyAudit {
  return {
    auditId: stringField(row, "audit_id"),
    batchId: stringField(row, "batch_id"),
    memorySpaceId: stringField(row, "memory_space_id"),
    targetBlockId: nullableStringField(row, "target_block_id"),
    result: enumField(row, "result", AUDIT_RESULTS),
    sourceFastIds: jsonField(row, "source_fast_ids"),
    createdAt: stringField(row, "created_at"),
  }
}

/** 将空间状态领域对象转换为关系表行。 */
export function spaceStateRow(state: DailySpaceState): RelationalRecord {
  return {
    memory_space_id: state.memorySpaceId,
    user_id: state.userId,
    successful_daily_count: state.successfulDailyCount,
    last_daily_at: state.lastDailyAt,
    last_weekly_at: state.lastWeeklyAt,
    created_at: state.createdAt,
    updated_at: state.updatedAt,
  }
}

/** 将关系表行还原为空间状态领域对象。 */
export function spaceStateFromRow(row: RelationalRecord): DailySpaceState {
  return {
    memorySpaceId: stringField(row, "memory_space_id"),
    userId: stringField(row, "user_id"),
    successfulDailyCount: intField(row, "successful_daily_count"),
    lastDailyAt: nullableStringField(row, "last_daily_at"),
    lastWeeklyAt: nullableStringField(row, "last_weekly_at"),
    createdAt: stringField(row, "created_at"),
    updatedAt: stringField(row, "updated_at"),
  }
}

// ============ 字段读取辅助 ============

function stringField(row: RelationalRecord, field: string): string {
  const value = row[field]
  if (typeof value !== "string") {
    throw new DailyMemoryError("schema-mismatch", `数据库字段 '${field}' 不是字符串`)
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
    throw new DailyMemoryError("schema-mismatch", `数据库字段 '${field}' 不是安全整数`)
  }
  return value
}

function boolField(row: RelationalRecord, field: string): boolean {
  const value = row[field]
  if (typeof value !== "boolean") {
    throw new DailyMemoryError("schema-mismatch", `数据库字段 '${field}' 不是布尔值`)
  }
  return value
}

function jsonField(row: RelationalRecord, field: string): JsonValue {
  const value = row[field]
  if (value === undefined || value === null) {
    throw new DailyMemoryError("schema-mismatch", `数据库字段 '${field}' 缺失或为 null`)
  }
  return value
}

function stageField(row: RelationalRecord, field: string): CheckpointStage {
  const value = intField(row, field)
  if (value < 0 || value > 9) {
    throw new DailyMemoryError("schema-mismatch", `数据库字段 '${field}' 不是合法阶段编号`)
  }
  return value as CheckpointStage
}

function enumField<T extends string>(
  row: RelationalRecord,
  field: string,
  allowed: readonly T[],
): T {
  const value = stringField(row, field)
  if (!allowed.includes(value as T)) {
    throw new DailyMemoryError("schema-mismatch", `数据库字段 '${field}' 包含未知值 '${value}'`)
  }
  return value as T
}
