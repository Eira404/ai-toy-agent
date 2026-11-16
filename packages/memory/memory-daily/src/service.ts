import { randomUUID } from "node:crypto"
import { Service, type Context } from "cordis"
import "toy-storage"
import "toy-memory-fast"
import "toy-memory-long"
import "toy-memory-feedback"
import "toy-llm"
import "toy-jev"
import "toy-embedding"
import "toy-parallel-executor"
import type { JsonValue, RelationalAdapter } from "toy-storage-relational"
import type { Scope } from "toy-memory-fast"
import { resolveDailyConfig, type DailyConfig, type ResolvedDailyConfig } from "./config.js"
import { DailyMemoryError } from "./error.js"
import type { DreamGate } from "./gate.js"
import { assertDailySchema, batchFromRow, batchRow } from "./relational.js"
import { DAILY_BATCHES_TABLE, DAILY_CHECKPOINTS_TABLE } from "./schema.js"
import type { StageEnv } from "./stage.js"
import { runFreeze } from "./stages/freeze/index.js"
import { runConsolidateValue } from "./stages/consolidate-value/index.js"
import { runConsolidateSession } from "./stages/consolidate-session/index.js"
import { runConsolidateCross } from "./stages/consolidate-cross/index.js"
import { runAssign } from "./stages/assign/index.js"
import { runGenerate } from "./stages/generate/index.js"
import { runCapacity } from "./stages/capacity/index.js"
import { runVerify } from "./stages/verify/index.js"
import { runSettle } from "./stages/settle/index.js"
import { runCommit } from "./stages/commit/index.js"
import {
  CHECKPOINT_STAGE,
  type DailyBatch,
  type DailyRunResult,
  type DailyValueEngine,
} from "./types.js"

declare module "cordis" {
  interface Context {
    memoryDaily: MemoryDaily
  }
}

/**
 * Daily Dream 服务：编排冻结、阶段零~八，含 Gate 请求、checkpoint 与整体重试。
 *
 * 价值引擎可不存在（通过 {@link registerValueEngine} 注入）：未注册时阶段零
 * 跳过、阶段七不衰减不归档。骨架阶段当前只实现冻结，后续阶段逐步接入。
 */
export class MemoryDaily extends Service {
  static inject = [
    "storage",
    "memoryFast",
    "memoryLong",
    "memoryFeedback",
    "llm",
    "jev",
    "embedding",
    "parallelExecutor",
  ]

  private readonly config: ResolvedDailyConfig
  private relational: RelationalAdapter | undefined
  private engine: DailyValueEngine | undefined
  private gate: DreamGate | undefined
  /** 正在运行的 Daily 空间集合（单实例 in-flight 守卫，防止同空间并发重复运行）。 */
  private readonly running = new Set<string>()

  constructor(ctx: Context, config: DailyConfig) {
    super(ctx, "memoryDaily")
    this.config = resolveDailyConfig(config)
  }

  /** 核对命名存储实例并校验表结构。 */
  [Service.init](): void {
    const relational = this.ctx.storage.tryGet<RelationalAdapter>(
      "relational",
      this.config.relationalSource,
    )
    if (relational === undefined) {
      throw new DailyMemoryError(
        "source-not-ready",
        `关系型存储实例 'relational/${this.config.relationalSource}' 尚未就绪`,
      )
    }
    assertDailySchema(relational)
    this.relational = relational
    this.ctx.parallelExecutor.registerPool("daily", {
      maxConcurrency: this.config.mapConcurrency,
    })
  }

  /**
   * 注册唯一的价值引擎（DailyValueEngine）。
   *
   * 价值系统插件初始化时同时注册到本包（价值结算）与 feedback 包（态度判断）。
   *
   * @param engine 实现 DailyValueEngine 的引擎。
   * @returns 注销函数；调用后清空当前引擎。
   * @throws {DailyMemoryError} 已有引擎注册时抛出 engine-already-registered。
   */
  registerValueEngine(engine: DailyValueEngine): () => void {
    if (this.engine !== undefined) {
      throw new DailyMemoryError("engine-already-registered", "价值引擎已注册")
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
   * 注册 Dream Gate（由 Runtime 实现，负责排空活跃 Session 并禁止新建）。
   *
   * 未注册时 `runDaily` 直接执行（供测试/单机环境）。生产环境应注册，否则
   * Dream 期间可能产生新的 Session Fast，破坏冻结基线的一致性。
   *
   * @param gate 实现 DreamGate 的运行时。
   * @returns 注销函数；调用后清空当前 Gate。
   * @throws {DailyMemoryError} 已有 Gate 注册时抛出 engine-already-registered。
   */
  registerGate(gate: DreamGate): () => void {
    if (this.gate !== undefined) {
      throw new DailyMemoryError("engine-already-registered", "Dream Gate 已注册")
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

  /**
   * 运行一次 Daily：创建批次 → 冻结 → 依次执行各阶段。
   *
   * @param scope 记忆空间范围（宿主已校验）。
   * @param options 可选 `gateCredential`：组合流程（Weekly 前置 Daily）已持有 Gate 时传入，
   *                本方法不再 acquire / release，复用该凭证。
   * @returns 本次批次 ID。
   */
  async runDaily(scope: Scope, options: { readonly gateCredential?: string } = {}): Promise<DailyRunResult> {
    const gate = this.gate
    const credential =
      options.gateCredential !== undefined
        ? options.gateCredential
        : (gate === undefined ? null : await gate.acquire(scope))
    try {
      this.assertNotRunning(scope)
      this.running.add(scope.memorySpaceId)
      const batchId = await this.startBatch(scope, credential)
      try {
        await this.runPipeline(scope, batchId)
      } catch (error) {
        await this.markBatchFailedSafely(batchId)
        throw error
      }
      return { batchId }
    } finally {
      this.running.delete(scope.memorySpaceId)
      // 仅在「本方法自己 acquire 了 Gate」时释放；外部传入的凭证由调用方（Weekly 组合流程）释放。
      if (options.gateCredential === undefined && gate !== undefined && credential !== null) {
        await gate.release(scope, credential)
      }
    }
  }

  /**
   * 异步启动一次 Daily：创建批次并立即返回 batchId，流水线在后台运行。
   *
   * 供管理员手动触发等「无需等待结果」的场景；与 `runDaily` 共用同一套 in-flight
   * 守卫，保证同一记忆空间不会并发运行两份 Daily。
   *
   * @param scope 记忆空间范围（宿主已校验）。
   * @returns 本次批次 ID（流水线仍在后台执行）。
   */
  async startDaily(scope: Scope): Promise<DailyRunResult> {
    this.assertNotRunning(scope)
    const gate = this.gate
    const credential = gate === undefined ? null : await gate.acquire(scope)
    this.running.add(scope.memorySpaceId)
    let batchId: string
    try {
      batchId = await this.startBatch(scope, credential)
    } catch (error) {
      this.running.delete(scope.memorySpaceId)
      if (gate !== undefined && credential !== null) {
        await gate.release(scope, credential)
      }
      throw error
    }
    void this.runInBackground(scope, batchId, gate, credential)
    return { batchId }
  }

  /** 拒绝同一记忆空间并发运行；`runDaily` 与 `startDaily` 共用。 */
  private assertNotRunning(scope: Scope): void {
    if (this.running.has(scope.memorySpaceId)) {
      throw new DailyMemoryError("conflict", "该记忆空间已有 Daily 在运行")
    }
  }

  /** 创建批次并落库，返回 batchId。 */
  private async startBatch(scope: Scope, credential: string | null): Promise<string> {
    const batchId = randomUUID()
    const now = this.config.now()
    const batch: DailyBatch = {
      batchId,
      userId: scope.userId,
      memorySpaceId: scope.memorySpaceId,
      status: "running",
      checkpointStage: CHECKPOINT_STAGE.freeze,
      gateCredential: credential,
      frozenFastCount: 0,
      frozenTurnCount: 0,
      decayEnabled: true,
      attemptCount: 1,
      lastError: null,
      frozenAt: null,
      startedAt: now,
      committedAt: null,
      finishedAt: null,
      createdAt: now,
      updatedAt: now,
    }
    await this.requireRelational().execute({
      type: "insert",
      table: DAILY_BATCHES_TABLE,
      value: batchRow(batch),
    })
    return batchId
  }

  /** 冻结 → 阶段零~八 → 提交。 */
  private async runPipeline(scope: Scope, batchId: string): Promise<void> {
    const env = this.buildEnv(scope, batchId)

    // 冻结 → checkpoint 0
    const freezeBaseline = await runFreeze(env)
    await this.saveCheckpoint(batchId, CHECKPOINT_STAGE.freeze, freezeBaseline)

    // 阶段零 · 巩固价值计算 → checkpoint 1
    const consolidation = await runConsolidateValue(env, freezeBaseline)
    await this.saveCheckpoint(batchId, CHECKPOINT_STAGE.consolidateValue, consolidation)

    // 阶段一 · Session 内整理 → checkpoint 2
    const sessionCandidates = await runConsolidateSession(env, freezeBaseline)
    await this.saveCheckpoint(batchId, CHECKPOINT_STAGE.consolidateSession, sessionCandidates)

    // 阶段二 · 跨 Session 整理 → checkpoint 3
    const longCandidates = await runConsolidateCross(env, sessionCandidates)
    await this.saveCheckpoint(batchId, CHECKPOINT_STAGE.consolidateCross, longCandidates)

    // 阶段三 · Long 候选归属 → checkpoint 4
    const assignments = await runAssign(env, longCandidates)
    await this.saveCheckpoint(batchId, CHECKPOINT_STAGE.assign, assignments)

    // 阶段四 · 按目标生成内容 → checkpoint 5
    const changePlans = await runGenerate(env, longCandidates, assignments)
    await this.saveCheckpoint(batchId, CHECKPOINT_STAGE.generate, changePlans)

    // 阶段五 · 模拟执行与容量整理 → checkpoint 6
    const capacityOutcomes = await runCapacity(env, changePlans)
    await this.saveCheckpoint(batchId, CHECKPOINT_STAGE.capacity, capacityOutcomes)

    // 阶段六 · 独立验证与局部放弃 → checkpoint 7
    const verifyOutcomes = await runVerify(env, capacityOutcomes)
    await this.saveCheckpoint(batchId, CHECKPOINT_STAGE.verify, verifyOutcomes)

    // 阶段七 · 价值结算与遗忘 → checkpoint 8
    const settlement = await runSettle(env, freezeBaseline, consolidation, verifyOutcomes)
    await this.saveCheckpoint(batchId, CHECKPOINT_STAGE.settle, settlement)

    // 阶段八 · 最终验证与原子提交
    await runCommit(env, freezeBaseline, settlement)
  }

  /** 后台执行流水线并收尾；`startDaily` 触发后 detach，不向调用方回传错误。 */
  private runInBackground(
    scope: Scope,
    batchId: string,
    gate: DreamGate | undefined,
    credential: string | null,
  ): void {
    void (async () => {
      try {
        await this.runPipeline(scope, batchId)
      } catch (error) {
        await this.markBatchFailedSafely(batchId)
        this.ctx.logger.warn("Daily 后台运行失败（%s）", scope.memorySpaceId, error)
      } finally {
        this.running.delete(scope.memorySpaceId)
        if (gate !== undefined && credential !== null) {
          try {
            await gate.release(scope, credential)
          } catch (error) {
            this.ctx.logger.warn("Daily Gate 释放失败（%s）", scope.memorySpaceId, error)
          }
        }
      }
    })()
  }

  /** 构造阶段运行上下文。 */
  private buildEnv(scope: Scope, batchId: string): StageEnv {
    return {
      scope,
      batchId,
      config: this.config,
      relational: this.requireRelational(),
      valueEngine: this.engine,
      fast: this.ctx.memoryFast,
      long: this.ctx.memoryLong,
      feedback: this.ctx.memoryFeedback,
      ctx: this.ctx,
    }
  }

  /** 写一个阶段的 checkpoint（确定性主键，重复写覆盖，天然幂等），并同步批次进度。 */
  private async saveCheckpoint(batchId: string, stage: number, payload: unknown): Promise<void> {
    const relational = this.requireRelational()
    await relational.execute({
      type: "upsert",
      table: DAILY_CHECKPOINTS_TABLE,
      value: {
        checkpoint_id: `${batchId}:${stage}`,
        batch_id: batchId,
        stage,
        payload: payload as JsonValue,
        created_at: this.config.now(),
      },
    })
    await relational.execute({
      type: "update",
      table: DAILY_BATCHES_TABLE,
      where: { type: "eq", field: "batch_id", value: batchId },
      patch: { checkpoint_stage: stage, updated_at: this.config.now() },
    })
  }

  /** 按 batchId 读取 Daily 批次；不存在返回 null。 */
  async getBatch(batchId: string): Promise<DailyBatch | null> {
    const result = await this.requireRelational().execute({
      type: "get",
      table: DAILY_BATCHES_TABLE,
      key: batchId,
    })
    return result.row === undefined ? null : batchFromRow(result.row)
  }

  /** 把批次标记为 failed；供进度查询区分「运行中」与「已失败」。 */
  private async markBatchFailed(batchId: string): Promise<void> {
    await this.requireRelational().execute({
      type: "update",
      table: DAILY_BATCHES_TABLE,
      where: { type: "eq", field: "batch_id", value: batchId },
      patch: {
        status: "failed",
        finished_at: this.config.now(),
        updated_at: this.config.now(),
      },
    })
  }

  /** 尽力标记失败；标记本身出错只告警，不掩盖主流程错误。 */
  private async markBatchFailedSafely(batchId: string): Promise<void> {
    try {
      await this.markBatchFailed(batchId)
    } catch (error) {
      this.ctx.logger.warn("标记 Daily 批次失败时出错（%s）", batchId, error)
    }
  }

  private requireRelational(): RelationalAdapter {
    if (this.relational === undefined) {
      throw new DailyMemoryError("source-not-ready", "关系型存储实例尚未初始化")
    }
    return this.relational
  }
}

export default MemoryDaily
