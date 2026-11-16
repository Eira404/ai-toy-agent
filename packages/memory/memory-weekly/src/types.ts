import type { JsonValue } from "toy-storage-relational"
import type { LongDomain, Scope, ValueState } from "toy-memory-long"

// ============ 价值契约（窄接口） ============

/** 初始化一个 Weekly 新价值单元的正文，结构与 Daily 的 `DailyUnitInput` 相同但独立声明。 */
export interface WeeklyUnitInput {
  readonly unitType: "overview" | "detail"
  /** 判断 Domain，参与重要性语境。 */
  readonly domain: LongDomain
  /** 块 title：overview 是块自身，detail 是父块 title。 */
  readonly title: string
  /** 单元 body：overview 是概述正文，detail 是细节正文。 */
  readonly body: string
}

/** Weekly 侧的价值引擎：只为新单元判重要程度并初始化，不衰减、不强化、不判生命周期。 */
export interface WeeklyValueEngine {
  initialize(inputs: readonly WeeklyUnitInput[]): Promise<ValueState[]>
}

// ============ 组合流程依赖 ============

/** 前置 Daily 执行器；`gateCredential` 用于复用组合流程已持有的 Gate 凭证。 */
export interface DailyRunner {
  runDaily(scope: Scope, options?: { readonly gateCredential?: string }): Promise<{ batchId: string }>
}

// ============ 存储对象与状态枚举 ============

/** Weekly 批次状态机。 */
export type WeeklyBatchStatus =
  "waiting_gate" | "running" | "committing" | "reconciling" | "succeeded" | "failed" | "abandoned"

/** checkpoint 阶段编号：0=freeze，1..7=结构阶段/容量/迁移/提交。 */
export type WeeklyCheckpointStage = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7

/** 结构操作类型（审计用）。 */
export type WeeklyStructureOp = "SPLIT" | "RECLASSIFY" | "MERGE" | "RENAME"

/** 批次主记录，与 `toy_memory_weekly_batches` 行一一对应（camelCase）。 */
export interface WeeklyBatch {
  readonly weeklyBatchId: string
  readonly userId: string
  readonly memorySpaceId: string
  readonly status: WeeklyBatchStatus
  readonly checkpointStage: WeeklyCheckpointStage
  readonly gateCredential: string | null
  readonly preDailyBatchId: string | null
  readonly preDailyRan: boolean
  readonly attemptCount: number
  readonly lastError: string | null
  readonly startedAt: string | null
  readonly committedAt: string | null
  readonly finishedAt: string | null
  readonly createdAt: string
  readonly updatedAt: string
}

/** 阶段可信中间结果；`payload` 为 opaque JSON。 */
export interface WeeklyCheckpoint {
  readonly checkpointId: string
  readonly batchId: string
  readonly stage: WeeklyCheckpointStage
  readonly payload: JsonValue
  readonly createdAt: string
}

/** 结构操作审计记录（粗粒度，不落旧→新价值单元的精确映射）。 */
export interface WeeklyOp {
  readonly opId: string
  readonly batchId: string
  readonly memorySpaceId: string
  readonly blockId: string
  readonly op: WeeklyStructureOp
  readonly relatedBlockIds: JsonValue
  readonly createdAt: string
}

/** checkpoint 阶段编号常量，与 `stages/` 下各文件夹一一对应。 */
export const CHECKPOINT_STAGE = {
  /** 冻结 + 修改集计算。 */
  freeze: 0,
  /** 阶段一 · SPLIT。 */
  split: 1,
  /** 阶段二 · RECLASSIFY。 */
  reclassify: 2,
  /** 阶段三 · MERGE。 */
  merge: 3,
  /** 阶段四 · RENAME。 */
  rename: 4,
  /** 阶段五 · 共享容量整理。 */
  capacity: 5,
  /** 阶段六 · 价值迁移。 */
  migrateValue: 6,
  /** 阶段七 · 原子提交。 */
  commit: 7,
} as const

/** 一次 Weekly 运行的结果；`skipped` 表示防饥饿条件未满足、未执行任何结构整理。 */
export interface WeeklyRunResult {
  readonly weeklyBatchId: string | null
  readonly skipped: boolean
}
