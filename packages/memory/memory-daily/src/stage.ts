import type { Context } from "cordis"
import type { MapTaskContext } from "toy-parallel-executor"
import type { RelationalAdapter } from "toy-storage-relational"
import type { FastMemory, Scope } from "toy-memory-fast"
import type { LongMemory } from "toy-memory-long"
import type { MemoryFeedback } from "toy-memory-feedback"
import type { ResolvedDailyConfig } from "./config.js"
import type { DailyValueEngine } from "./types.js"

/**
 * 阶段运行上下文：一次 Daily 批次内、各阶段共享的依赖与元数据。
 *
 * 由 `MemoryDaily` 在启动批次时构造，逐个传给阶段主函数。价值引擎可不存在：
 * 未注册时 `valueEngine` 为 `undefined`，阶段零跳过、阶段七不做衰减归档。
 */
export interface StageEnv {
  /** 本次批次的隔离范围。 */
  readonly scope: Scope
  /** 本次批次 ID（幂等键）。 */
  readonly batchId: string
  /** 已解析的插件配置。 */
  readonly config: ResolvedDailyConfig
  /** Daily 自己的关系型 adapter（batches / checkpoints / audits / space_state）。 */
  readonly relational: RelationalAdapter
  /** 已注册的价值引擎；未注册时为 undefined。 */
  readonly valueEngine: DailyValueEngine | undefined
  /** Fast 服务。 */
  readonly fast: FastMemory
  /** Long 服务。 */
  readonly long: LongMemory
  /** Feedback 服务。 */
  readonly feedback: MemoryFeedback
  /** Cordis 上下文，供阶段访问 ctx.llm / ctx.jev / ctx.embedding。 */
  readonly ctx: Context
}

/**
 * 并行执行一个阶段的独立 item。
 *
 * 使用 `parallelExecutor.map`（严格批）：首项失败即停止派发并取消其余在途项、
 * 按输入顺序返回结果，与旧串行循环的 fail-fast 语义一致。任务池 `daily` 由
 * `MemoryDaily` 在初始化时注册，`mapConcurrency` 控制本批并发上限。
 */
export function mapStage<T, R>(
  env: StageEnv,
  items: readonly T[],
  worker: (item: T, context: MapTaskContext) => R | PromiseLike<R>,
  name: string,
): Promise<R[]> {
  return env.ctx.parallelExecutor.map(items, worker, {
    pool: "daily",
    concurrency: env.config.mapConcurrency,
    batchId: env.batchId,
    name,
  })
}
