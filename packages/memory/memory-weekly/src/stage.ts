import type { Context } from "cordis"
import type { RelationalAdapter } from "toy-storage-relational"
import type { LongMemory, Scope } from "toy-memory-long"
import type { ResolvedWeeklyConfig } from "./config.js"
import type { WeeklyValueEngine } from "./types.js"

/**
 * 阶段运行上下文：一次 Weekly 批次内、各阶段共享的依赖与元数据。
 *
 * 由 `MemoryWeekly` 在启动批次时构造，逐个传给阶段主函数。价值引擎可不存在：
 * 未注册时 `valueEngine` 为 `undefined`，价值迁移阶段只做 INHERIT、INITIALIZE 写占位状态。
 */
export interface WeeklyStageEnv {
  /** 本次批次的隔离范围。 */
  readonly scope: Scope
  /** 本次批次 ID（幂等键）。 */
  readonly weeklyBatchId: string
  /** 已解析的插件配置。 */
  readonly config: ResolvedWeeklyConfig
  /** Weekly 自己的关系型 adapter（batches / checkpoints / ops）。 */
  readonly relational: RelationalAdapter
  /** 已注册的价值引擎；未注册时为 undefined。 */
  readonly valueEngine: WeeklyValueEngine | undefined
  /** Long 服务。 */
  readonly long: LongMemory
  /** Cordis 上下文，供阶段访问 ctx.llm / ctx.jev / ctx.embedding。 */
  readonly ctx: Context
}
