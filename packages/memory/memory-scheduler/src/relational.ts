import type {
  JsonValue,
  RelationalAdapter,
  RelationalFilter,
  RelationalRecord,
} from "toy-storage-relational"
import { SchedulerError } from "./error.js"
import { schedulerRelationalSchema } from "./schema.js"
import type { DailySchedule, ScheduleKind } from "./types.js"

/**
 * 关系表行（snake_case）与公共类型（camelCase）之间的映射。
 *
 * 行由 adapter 返回或写入，字段名与 `schema.ts` 保持一致；对外只暴露
 * camelCase 的领域类型，避免上层接触数据库命名。
 */

const SCHEDULE_KINDS: readonly ScheduleKind[] = ["daily"]

/** 将公开调度对象转换为关系表行。 */
export function scheduleRow(schedule: DailySchedule): RelationalRecord {
  return {
    memory_space_id: schedule.memorySpaceId,
    user_id: schedule.userId,
    kind: schedule.kind,
    enabled: schedule.enabled,
    daily_at: schedule.dailyAt,
    time_zone: schedule.timeZone,
    min_pending_fast: schedule.minPendingFast,
    last_triggered_at: schedule.lastTriggeredAt,
    next_run_at: schedule.nextRunAt,
    created_at: schedule.createdAt,
    updated_at: schedule.updatedAt,
  }
}

/** 将关系表行还原为公开调度对象。 */
export function scheduleFromRow(row: RelationalRecord): DailySchedule {
  return {
    memorySpaceId: asString(row, "memory_space_id"),
    userId: asString(row, "user_id"),
    kind: enumField(row, "kind", SCHEDULE_KINDS),
    enabled: asBoolean(row, "enabled"),
    dailyAt: asString(row, "daily_at"),
    timeZone: nullableString(row, "time_zone"),
    minPendingFast: asInteger(row, "min_pending_fast"),
    lastTriggeredAt: nullableString(row, "last_triggered_at"),
    nextRunAt: nullableString(row, "next_run_at"),
    createdAt: asString(row, "created_at"),
    updatedAt: asString(row, "updated_at"),
  }
}

/**
 * 校验命名 adapter 是否配置了本包需要的表。
 *
 * 只核对表名、主键、字段类型、可空性与索引，不负责数据库迁移；
 * 由宿主持有本包导出的 Schema 并交给具体 adapter 创建结构。
 */
export function assertSchedulerSchema(relational: RelationalAdapter): void {
  for (const [name, required] of Object.entries(schedulerRelationalSchema.tables)) {
    const actual = relational.schema.tables[name]
    if (actual?.primaryKey !== required.primaryKey) {
      throw new SchedulerError("schema-mismatch", `数据源缺少正确的 '${name}' 表或主键`)
    }
    for (const [field, expected] of Object.entries(required.columns)) {
      const column = actual.columns[field]
      const nullable = "nullable" in expected && expected.nullable === true
      if (column?.type !== expected.type || (column.nullable === true) !== nullable) {
        throw new SchedulerError("schema-mismatch", `数据源字段 '${name}.${field}' 与 Scheduler 定义不一致`)
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
        throw new SchedulerError("schema-mismatch", `数据源缺少 '${name}.${index.name}' 索引定义`)
      }
    }
  }
}

/** 构造单字段相等条件。 */
export function eq(field: string, value: JsonValue): RelationalFilter {
  return { type: "eq", field, value }
}

/** 构造单字段小于等于条件（用于 datetime 到期扫描）。 */
export function lte(field: string, value: JsonValue): RelationalFilter {
  return { type: "lte", field, value }
}

/** 构造多条件 AND 组合。 */
export function andWhere(conditions: readonly RelationalFilter[]): RelationalFilter {
  return { type: "and", conditions: [...conditions] }
}

// ---------------------------------------------------------------------------
// 字段读取辅助
// ---------------------------------------------------------------------------

function asString(row: RelationalRecord, field: string): string {
  const value = row[field]
  if (typeof value !== "string") {
    throw new SchedulerError("schema-mismatch", `关系表字段 '${field}' 不是字符串`)
  }
  return value
}

function nullableString(row: RelationalRecord, field: string): string | null {
  const value = row[field]
  if (value === null || value === undefined) {
    return null
  }
  if (typeof value !== "string") {
    throw new SchedulerError("schema-mismatch", `关系表字段 '${field}' 不是字符串`)
  }
  return value
}

function asBoolean(row: RelationalRecord, field: string): boolean {
  const value = row[field]
  if (typeof value !== "boolean") {
    throw new SchedulerError("schema-mismatch", `关系表字段 '${field}' 不是布尔值`)
  }
  return value
}

function asInteger(row: RelationalRecord, field: string): number {
  const value = row[field]
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new SchedulerError("schema-mismatch", `关系表字段 '${field}' 不是安全整数`)
  }
  return value
}

function enumField<T extends string>(row: RelationalRecord, field: string, allowed: readonly T[]): T {
  const value = asString(row, field)
  if (!allowed.includes(value as T)) {
    throw new SchedulerError("schema-mismatch", `关系表字段 '${field}' 包含未知值 '${value}'`)
  }
  return value as T
}
