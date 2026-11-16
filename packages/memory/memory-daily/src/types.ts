import type { JsonValue } from "toy-storage-relational"
import type { FeedbackJudgement } from "toy-memory-feedback"
import type { LifecycleStatus, LongDomain, ValueState } from "toy-memory-long"

/**
 * `toy-memory-daily` 的价值契约。
 *
 * 价值系统被拆成两个接口：`toy-memory-feedback` 声明 `FeedbackValueEngine`
 * （Session 收尾态度判断），本包声明 `DailyValueEngine`（Daily 巩固价值计算）。
 * 引擎一个类实现两个接口，初始化时分别注册到两边。引擎可不存在：未注册时
 * daily 跳过阶段零、不衰减不归档（记忆永不遗忘），内容整理照常进行。
 */

// `ValueState` 与 `LifecycleStatus` 均从 `toy-memory-long` 导入：
// 价值状态只含 `valueData` + `valueVersion`（opaque），lifecycle 属于
// block/detail 层（Long 的 `lifecycleStatus`），由引擎的 `lifecycle()` 判断。

/**
 * 价值单元的正文内容，供 `reinforceUpdated` 判断正文变化。
 *
 * - overview（块）：`title` + `summary` + `body`；
 * - detail：`summary` + `body`。
 */
export type UnitContent =
  | {
      readonly unitType: "overview"
      readonly title: string
      readonly summary: string
      readonly body: string
    }
  | {
      readonly unitType: "detail"
      readonly summary: string
      readonly body: string
    }

/**
 * 新建价值单元的正文，供 `initialize` 判断重要程度并初始化。
 */
export interface DailyUnitInput {
  readonly unitType: "overview" | "detail"
  /** 判断 Domain，参与重要性语境。 */
  readonly domain: LongDomain
  /** 块 title：overview 是块自身，detail 是父块 title。 */
  readonly title: string
  /** 单元 body：overview 是概述正文，detail 是细节正文。 */
  readonly body: string
}

/**
 * 价值系统在 daily 侧声明的接口：负责 Daily 巩固阶段的价值数值计算。
 *
 * 实现方同时实现本接口与 `FeedbackValueEngine`，并在初始化时分别注册到
 * daily 与 feedback。本接口的所有方法都是纯价值计算：daily 只负责编排
 * 「何时对哪个单元调用哪个方法」，不解析任何价值数值。
 */
export interface DailyValueEngine {
  /** 阶段零：旧状态 + 本批反馈判断 → 强化后状态（R0）。 */
  settle(input: { state: ValueState; judgements: readonly FeedbackJudgement[] }): ValueState

  /** 阶段七：正文更新强化（R7），异步判断旧/新正文的语义变化。 */
  reinforceUpdated(input: {
    state: ValueState
    oldContent: UnitContent
    newContent: UnitContent
  }): Promise<ValueState>

  /** 阶段七：批量初始化新单元，引擎内部判重要性。 */
  initialize(inputs: readonly DailyUnitInput[]): Promise<ValueState[]>

  /** 统一衰减：推进一个衰减周期，内部更新 V、belowThresholdCycles。 */
  decay(state: ValueState): ValueState

  /** 双路取大：返回价值更大的那个（内部比较 valueData 里的 V）。 */
  max(a: ValueState, b: ValueState): ValueState

  /** 从 valueData 解析出该价值状态的生命周期，供 Daily 判断是否归档。 */
  lifecycle(state: ValueState): LifecycleStatus
}

// ============ 存储对象与状态枚举（与阶段逻辑无关） ============

/** Daily 批次状态机。 */
export type DailyBatchStatus =
  "waiting_gate" | "running" | "committing" | "reconciling" | "succeeded" | "failed" | "abandoned"

/** checkpoint 阶段编号：0=冻结，1=阶段零，2..9=阶段一..八。 */
export type CheckpointStage = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9

/** 阶段八每个目标块的审计结果。 */
export type DailyAuditResult = "APPLY" | "LOCAL_ABANDON"

/** 批次主记录，与 `toy_memory_daily_batches` 行一一对应（camelCase）。 */
export interface DailyBatch {
  readonly batchId: string
  readonly userId: string
  readonly memorySpaceId: string
  readonly status: DailyBatchStatus
  readonly checkpointStage: CheckpointStage
  readonly gateCredential: string | null
  readonly frozenFastCount: number
  readonly frozenTurnCount: number
  readonly decayEnabled: boolean
  readonly attemptCount: number
  readonly lastError: string | null
  readonly frozenAt: string | null
  readonly startedAt: string | null
  readonly committedAt: string | null
  readonly finishedAt: string | null
  readonly createdAt: string
  readonly updatedAt: string
}

/** 阶段可信中间结果；`payload` 为 opaque JSON，各阶段结构见阶段设计。 */
export interface DailyCheckpoint {
  readonly checkpointId: string
  readonly batchId: string
  readonly stage: CheckpointStage
  readonly payload: JsonValue
  readonly createdAt: string
}

/** 阶段八审计记录。 */
export interface DailyAudit {
  readonly auditId: string
  readonly batchId: string
  readonly memorySpaceId: string
  readonly targetBlockId: string | null
  readonly result: DailyAuditResult
  readonly sourceFastIds: JsonValue
  readonly createdAt: string
}

/** 空间级状态（成功 Daily 计数，供 Weekly 防饥饿）。 */
export interface DailySpaceState {
  readonly memorySpaceId: string
  readonly userId: string
  readonly successfulDailyCount: number
  readonly lastDailyAt: string | null
  readonly lastWeeklyAt: string | null
  readonly createdAt: string
  readonly updatedAt: string
}

/** checkpoint 阶段编号常量，与 `stages/` 下各文件夹一一对应。 */
export const CHECKPOINT_STAGE = {
  /** 冻结 + Gate。 */
  freeze: 0,
  /** 阶段零 · 记忆巩固价值计算。 */
  consolidateValue: 1,
  /** 阶段一 · Session 内整理。 */
  consolidateSession: 2,
  /** 阶段二 · 跨 Session 整理。 */
  consolidateCross: 3,
  /** 阶段三 · Long 候选归属。 */
  assign: 4,
  /** 阶段四 · 按目标生成内容。 */
  generate: 5,
  /** 阶段五 · 模拟执行与容量整理。 */
  capacity: 6,
  /** 阶段六 · 独立验证与局部放弃。 */
  verify: 7,
  /** 阶段七 · 价值结算与遗忘。 */
  settle: 8,
  /** 阶段八 · 最终验证与原子提交。 */
  commit: 9,
} as const

/** 一次 Daily 运行的结果。 */
export interface DailyRunResult {
  readonly batchId: string
}
