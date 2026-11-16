import { randomUUID } from "node:crypto"
import { Service, type Context } from "cordis"
import "toy-storage"
import "toy-memory-long"
import type { JsonValue, RelationalAdapter } from "toy-storage-relational"
import type { Scope } from "toy-memory-long"
import { DAILY_SPACE_STATE_TABLE } from "toy-memory-daily"
import { resolveWeeklyConfig, type ResolvedWeeklyConfig, type WeeklyConfig } from "./config.js"
import { WeeklyMemoryError } from "./error.js"
import type { DreamGate } from "./gate.js"
import { assertWeeklySchema, weeklyBatchRow } from "./relational.js"
import { WEEKLY_BATCHES_TABLE, WEEKLY_CHECKPOINTS_TABLE } from "./schema.js"
import type { WeeklyStageEnv } from "./stage.js"
import { runFreeze } from "./stages/freeze/index.js"
import { runReclassify } from "./stages/reclassify/index.js"
import {
  CHECKPOINT_STAGE,
  type DailyRunner,
  type WeeklyBatch,
  type WeeklyRunResult,
  type WeeklyValueEngine,
} from "./types.js"

declare module "cordis" {
  interface Context {
    memoryWeekly: MemoryWeekly
  }
}

/**
 * Weekly Dream 服务：整理已有 Long 块结构的离线链路（SPLIT/RECLASSIFY/MERGE/RENAME）。
 *
 * 组合流程由本服务持有：acquire Gate → 防饥饿判定 → 前置 Daily → freeze → 七阶段 → commit。
 * 价值引擎可不存在：未注册时价值迁移只做 INHERIT，INITIALIZE 写占位状态。
 */
export class MemoryWeekly extends Service {
  static inject = ["storage", "memoryLong", "llm", "jev", "embedding"]

  private readonly config: ResolvedWeeklyConfig
  private relational: RelationalAdapter | undefined
  private engine: WeeklyValueEngine | undefined
  private gate: DreamGate | undefined
  private dailyRunner: DailyRunner | undefined

  constructor(ctx: Context, config: WeeklyConfig) {
    super(ctx, "memoryWeekly")
    this.config = resolveWeeklyConfig(config)
  }

  /** 核对命名存储实例并校验表结构。 */
  [Service.init](): void {
    const relational = this.ctx.storage.tryGet<RelationalAdapter>(
      "relational",
      this.config.relationalSource,
    )
    if (relational === undefined) {
      throw new WeeklyMemoryError(
        "source-not-ready",
        `关系型存储实例 'relational/${this.config.relationalSource}' 尚未就绪`,
      )
    }
    assertWeeklySchema(relational)
    this.relational = relational
  }

  /**
   * 注册唯一的价值引擎（WeeklyValueEngine）。
   * @returns 注销函数；调用后清空当前引擎。
   */
  registerValueEngine(engine: WeeklyValueEngine): () => void {
    if (this.engine !== undefined) {
      throw new WeeklyMemoryError("engine-already-registered", "价值引擎已注册")
    }
    this.engine = engine
    let disposed = false
    return () => {
      if (!disposed && this.engine === engine) {
        disposed = true
        this.engine = undefined
      }
    }
  }

  /**
   * 注册 Dream Gate（由 Runtime 实现）。组合流程中前置 Daily 与 Weekly 复用同一 Gate。
   */
  registerGate(gate: DreamGate): () => void {
    if (this.gate !== undefined) {
      throw new WeeklyMemoryError("gate-already-registered", "Dream Gate 已注册")
    }
    this.gate = gate
    let disposed = false
    return () => {
      if (!disposed && this.gate === gate) {
        disposed = true
        this.gate = undefined
      }
    }
  }

  /** 注册前置 Daily 执行器；未注册时组合流程跳过前置 Daily，直接整理当前 Long。 */
  registerDailyRunner(runner: DailyRunner): () => void {
    if (this.dailyRunner !== undefined) {
      throw new WeeklyMemoryError("daily-runner-already-registered", "前置 Daily 执行器已注册")
    }
    this.dailyRunner = runner
    let disposed = false
    return () => {
      if (!disposed && this.dailyRunner === runner) {
        disposed = true
        this.dailyRunner = undefined
      }
    }
  }

  /**
   * 运行一次 Weekly 组合流程。
   *
   * @returns `skipped: true` 表示防饥饿条件未满足（无前置 Daily、无结构整理）。
   */
  async runWeekly(scope: Scope): Promise<WeeklyRunResult> {
    const gate = this.gate
    const credential = gate === undefined ? null : await gate.acquire(scope)
    try {
      // 1) 防饥饿判定：上次成功 Weekly 后成功 Daily 次数是否达到 N。
      //    （turn 活动阈值暂未接入，故此处只判 successfulDailyCount）
      const spaceState = await this.readDailySpaceState(scope)
      if (spaceState.successfulDailyCount < this.config.antiStarvationN) {
        return { weeklyBatchId: null, skipped: true }
      }

      // 2) 前置 Daily（复用同一 Gate 凭证）。
      let preDailyBatchId: string | null = null
      let preDailyRan = false
      if (this.dailyRunner !== undefined) {
        const options = credential === null ? {} : { gateCredential: credential }
        preDailyBatchId = (await this.dailyRunner.runDaily(scope, options)).batchId
        preDailyRan = true
      }

      // 3) 创建 Weekly 批次。
      const weeklyBatchId = randomUUID()
      const now = this.config.now()
      const batch: WeeklyBatch = {
        weeklyBatchId,
        userId: scope.userId,
        memorySpaceId: scope.memorySpaceId,
        status: "running",
        checkpointStage: CHECKPOINT_STAGE.freeze,
        gateCredential: credential,
        preDailyBatchId,
        preDailyRan,
        attemptCount: 1,
        lastError: null,
        startedAt: now,
        committedAt: null,
        finishedAt: null,
        createdAt: now,
        updatedAt: now,
      }
      await this.requireRelational().execute({
        type: "insert",
        table: WEEKLY_BATCHES_TABLE,
        value: weeklyBatchRow(batch),
      })

      const env = this.buildEnv(scope, weeklyBatchId)

      // 4) freeze → checkpoint 0
      const freezeBaseline = await runFreeze(env, spaceState.lastWeeklyAt)
      await this.saveCheckpoint(weeklyBatchId, CHECKPOINT_STAGE.freeze, freezeBaseline)

      // 阶段一 · split → checkpoint 1（TODO：暂直接使用 freeze 快照）
      let snapshot = freezeBaseline.snapshot

      // 阶段二 · reclassify → checkpoint 2
      snapshot = await runReclassify(env, snapshot, freezeBaseline.modifiedBlockIds)
      await this.saveCheckpoint(weeklyBatchId, CHECKPOINT_STAGE.reclassify, snapshot)

      // TODO: 阶段三~七（merge / rename / capacity / migrate-value / commit）
      //   commit 阶段负责：applyChanges + 写 weekly_ops + 清零 successful_daily_count + 写 last_weekly_at + 批次 succeeded

      return { weeklyBatchId, skipped: false }
    } finally {
      if (gate !== undefined && credential !== null) {
        await gate.release(scope, credential)
      }
    }
  }

  /** 构造阶段运行上下文。 */
  private buildEnv(scope: Scope, weeklyBatchId: string): WeeklyStageEnv {
    return {
      scope,
      weeklyBatchId,
      config: this.config,
      relational: this.requireRelational(),
      valueEngine: this.engine,
      long: this.ctx.memoryLong,
      ctx: this.ctx,
    }
  }

  /** 写一个阶段的 checkpoint（确定性主键，重复写覆盖，天然幂等）。 */
  private async saveCheckpoint(weeklyBatchId: string, stage: number, payload: unknown): Promise<void> {
    await this.requireRelational().execute({
      type: "upsert",
      table: WEEKLY_CHECKPOINTS_TABLE,
      value: {
        checkpoint_id: `${weeklyBatchId}:${stage}`,
        batch_id: weeklyBatchId,
        stage,
        payload: payload as JsonValue,
        created_at: this.config.now(),
      },
    })
  }

  /** 读取 daily 空间状态（成功 Daily 计数 + 上次 Weekly 时间），供防饥饿与修改集计算。 */
  private async readDailySpaceState(scope: Scope): Promise<{
    successfulDailyCount: number
    lastWeeklyAt: string | null
  }> {
    const result = await this.requireRelational().execute({
      type: "get",
      table: DAILY_SPACE_STATE_TABLE,
      key: scope.memorySpaceId,
    })
    const row = result.row
    if (row === undefined) {
      return { successfulDailyCount: 0, lastWeeklyAt: null }
    }
    const count = row["successful_daily_count"]
    const last = row["last_weekly_at"]
    return {
      successfulDailyCount: typeof count === "number" && Number.isSafeInteger(count) ? count : 0,
      lastWeeklyAt: typeof last === "string" ? last : null,
    }
  }

  private requireRelational(): RelationalAdapter {
    if (this.relational === undefined) {
      throw new WeeklyMemoryError("source-not-ready", "关系型存储实例尚未初始化")
    }
    return this.relational
  }
}

export default MemoryWeekly
