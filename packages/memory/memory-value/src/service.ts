import { Service, type Context } from "cordis"
import "toy-llm"
import "toy-memory-feedback"
import "toy-memory-daily"
import type { FeedbackValueEngine, JudgeSessionInput } from "toy-memory-feedback"
import type { DailyValueEngine, DailyUnitInput } from "toy-memory-daily"
import type { ValueState } from "toy-memory-long"
import type { MemoryValueConfig } from "./config.js"
import { ValueEngine } from "./engine.js"

declare module "cordis" {
  interface Context {
    /** 插件挂载后的价值计算入口；通常由 feedback/daily 通过已注册的引擎调用。 */
    memoryValue: MemoryValue
  }
}

/**
 * Cordis 插件入口，挂载为 ctx.memoryValue，并自动向 feedback/daily 注册同一个 ValueEngine。
 *
 * @example
 * await ctx.plugin(MemoryValue, { llmProvider: "provider", llmModel: "model" })
 * const [state] = await ctx.memoryValue.initialize(inputs)
 *
 * 依赖 llm、memoryFeedback、memoryDaily 服务；卸载插件时注销两侧注册。
 * 各公开方法与 ValueEngine 同名方法的输入、返回值和错误语义相同。
 */
export class MemoryValue extends Service implements FeedbackValueEngine, DailyValueEngine {
  static inject = ["llm", "memoryFeedback", "memoryDaily"]
  private readonly engine: ValueEngine

  /**
   * @param ctx 已加载三个依赖服务的 Cordis 上下文。
   * @param config 模型路由及可选数值参数；仅构造引擎，实际注册在 Service.init 中完成。
   */
  constructor(ctx: Context, config: MemoryValueConfig) {
    super(ctx, "memoryValue")
    this.engine = new ValueEngine(ctx.llm, config)
  }

  /** Cordis 自动调用；两侧注册作为一个 effect 管理，第二侧失败则回滚第一侧。 */
  [Service.init](): void {
    this.ctx.effect(() => {
      // 传底层普通对象，避免让调用方依赖当前 Service 的跨上下文代理。
      const unregisterFeedback = this.ctx.memoryFeedback.registerValueEngine(this.engine)
      let unregisterDaily: () => void
      try {
        unregisterDaily = this.ctx.memoryDaily.registerValueEngine(this.engine)
      } catch (error) {
        unregisterFeedback()
        throw error
      }
      return () => {
        unregisterDaily()
        unregisterFeedback()
      }
    })
  }

  /**
   * Session 收尾时异步判断态度和用户证据；返回反馈，不直接修改价值。
   * @see ValueEngine.judgeSession 完整参数、错误和调用说明。
   */
  judgeSession(input: JudgeSessionInput) {
    return this.engine.judgeSession(input)
  }

  /**
   * 为新单元异步判断重要性并初始化，结果与输入顺序对应，不衰减。
   * @see ValueEngine.initialize
   */
  initialize(inputs: readonly DailyUnitInput[]) {
    return this.engine.initialize(inputs)
  }

  /**
   * 同步计算反馈强化分支 R0，judgements 使用本引擎的版本化产物，不衰减。
   * @see ValueEngine.settle
   */
  settle(input: Parameters<DailyValueEngine["settle"]>[0]) {
    return this.engine.settle(input)
  }

  /**
   * 异步计算正文更新分支 R7；调用方必须 await，不衰减。
   * @see ValueEngine.reinforceUpdated
   */
  reinforceUpdated(input: Parameters<DailyValueEngine["reinforceUpdated"]>[0]) {
    return this.engine.reinforceUpdated(input)
  }

  /**
   * 同步推进一个衰减周期；通常在两路取大之后调用一次。
   * @see ValueEngine.decay
   */
  decay(state: ValueState) {
    return this.engine.decay(state)
  }

  /**
   * 同步选择同一单元价值更高的完整分支，不叠加强化。
   * @see ValueEngine.max
   */
  max(a: ValueState, b: ValueState) {
    return this.engine.max(a, b)
  }

  /**
   * 只读查询最终状态的生命周期，不推进周期。
   * @see ValueEngine.lifecycle
   */
  lifecycle(state: ValueState) {
    return this.engine.lifecycle(state)
  }
}
