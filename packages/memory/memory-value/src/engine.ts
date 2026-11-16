import { z } from "zod"
import type { LlmRuntime } from "toy-llm"
import { LlmSupportModel } from "toy-model-support"
import type { FeedbackValueEngine, JudgeSessionInput } from "toy-memory-feedback"
import type { DailyValueEngine, DailyUnitInput } from "toy-memory-daily"
import type { WeeklyValueEngine, WeeklyUnitInput } from "toy-memory-weekly"
import type { ValueState, LifecycleStatus } from "toy-memory-long"
import {
  resolveMemoryValueConfig,
  type MemoryValueConfig,
  type ResolvedMemoryValueConfig,
} from "./config.js"
import { decodeValueState, encodeValueState, type ValueData } from "./state.js"
import { ForgettingEngine } from "./forgetting.js"
import { FeedbackJudge, validateJudgement } from "./judges/feedback.js"
import { ImportanceJudge } from "./judges/importance.js"
import { ContentChangeJudge } from "./judges/content-change.js"
import { ValueUnitInputSchema, UnitContentSchema } from "./schema.js"
import { ValueEngineError } from "./error.js"

/**
 * 价值引擎的统一业务入口，同时实现 feedback 态度判断和 daily 价值计算契约。
 *
 * 一般通过 `ctx.plugin(MemoryValue, config)` 使用；需要自行装配时可直接构造本类。
 * 所有方法均不修改输入状态、不落库。judgeSession/initialize/reinforceUpdated 可能
 * 调用模型，其余方法只做确定性计算。跨调用需要保留的事实均通过参数传入。
 */
export class ValueEngine implements FeedbackValueEngine, DailyValueEngine, WeeklyValueEngine {
  /** 校验并冻结后的配置；解释已有状态时应保持算法参数一致。 */
  readonly config: ResolvedMemoryValueConfig
  private readonly forgetting: ForgettingEngine
  private readonly feedbackJudge: FeedbackJudge
  private readonly importanceJudge: ImportanceJudge
  private readonly changeJudge: ContentChangeJudge

  /**
   * @param llm 已配置相应 provider/adapter 的 LLM runtime。
   * @param config 三个判断器共用的模型路由，以及可选的旧算法参数覆盖。
   * @throws 配置不满足范围或参数关系时抛出 Zod 校验错误。
   */
  constructor(llm: LlmRuntime, config: MemoryValueConfig) {
    this.config = resolveMemoryValueConfig(config)
    this.forgetting = new ForgettingEngine(this.config.forgetting)
    const modelConfig = {
      provider: this.config.llmProvider,
      model: this.config.llmModel,
      temperature: this.config.temperature,
      maxTokens: this.config.maxTokens,
    }
    this.feedbackJudge = new FeedbackJudge(
      new LlmSupportModel("memory_value_feedback", llm, modelConfig),
    )
    this.importanceJudge = new ImportanceJudge(
      new LlmSupportModel("memory_value_importance", llm, modelConfig),
    )
    this.changeJudge = new ContentChangeJudge(
      new LlmSupportModel("memory_value_content_change", llm, modelConfig),
    )
  }

  /**
   * Session 收尾时判断用户对一个已召回记忆单元的态度。
   *
   * @param input 实际召回的正文快照、助手语境、后续用户对话及可选取消信号。
   * overview 的 recalledContent 使用 overviewBody；detail 使用 body，不重查当前正文。
   * @returns 带证据轮次和版本化私有数据的 FeedbackJudgement；尚未改变记忆价值。
   * @throws ValueEngineError 输入、证据或模型输出无效时抛错；取消时传播 signal.reason。
   * @example
   * const judgement = await engine.judgeSession(input)
   * // 保存 judgement，后续作为 settle 的 judgements 元素使用。
   */
  judgeSession(input: JudgeSessionInput) {
    return this.feedbackJudge.judge(input)
  }

  /**
   * 为新建概述或 detail 判断重要性并创建价值状态；本步骤不执行衰减。
   *
   * @param inputs 每项包含 unitType、domain、title、body；detail 的 title 是父块标题。
   * @returns 与输入长度和顺序一致的状态数组；空输入返回 [] 且不调用模型。
   * 当前逐项串行判断，任一失败就拒绝整个 Promise，不返回部分成功结果。
   * @throws ValueEngineError 输入无效或重要性模型失败。
   * @example
   * const [state] = await engine.initialize([
   *   { unitType: "overview", domain: "self", title: "咖啡偏好", body: "用户喜欢冰美式。" },
   * ])
   */
  initialize(inputs: readonly DailyUnitInput[]): Promise<ValueState[]>
  initialize(inputs: readonly WeeklyUnitInput[]): Promise<ValueState[]>
  async initialize(inputs: readonly (DailyUnitInput | WeeklyUnitInput)[]): Promise<ValueState[]> {
    const parsed = z.array(ValueUnitInputSchema).safeParse(inputs)
    if (!parsed.success) {
      throw new ValueEngineError("invalid-input", "新价值单元输入无效", { cause: parsed.error })
    }
    const states: ValueState[] = []
    // 保持顺序，避免初始化批次无界并发调用模型。
    for (const input of parsed.data) {
      const importance = await this.importanceJudge.judge(input)
      states.push(encodeValueState(this.forgetting.initialize(importance)))
    }
    return states
  }

  /**
   * 从旧状态出发，顺序应用本批反馈，生成反馈强化分支 R0。
   *
   * @param input state 是本单元原状态；judgements 是本引擎产生、按业务顺序排列的反馈。
   * 先校验每条反馈的版本与证据结构，再应用旧增益；纠错等非正向态度不强化。
   * @returns 新的版本化状态，不调用模型，不推进衰减周期，也不消费输入反馈。
   * @throws ValueEngineError 状态/反馈版本未知，或私有判断数据不一致。
   * @example
   * const r0 = engine.settle({ state: original, judgements: [judgement] })
   */
  settle(input: Parameters<DailyValueEngine["settle"]>[0]): ValueState {
    let state = decodeValueState(input.state)
    for (const judgement of input.judgements) {
      const valid = validateJudgement(judgement)
      state = this.forgetting.reinforce(state, valid.feedbackType)
    }
    return encodeValueState(state)
  }

  /**
   * 从原状态与旧新正文生成正文强化分支 R7，需 await 语义判断完成。
   *
   * @param input oldContent/newContent 必须是相同 unitType，概述和 detail 在此都使用 body。
   * @returns 补充事实、有效状态变化按 supplemented 增益强化；纯改写、纠错等保留原状态。
   * 已归档单元不复活；I 保持不变；不修改正文、不推进衰减。未强化时可能返回原对象。
   * @throws ValueEngineError 状态、内容类型无效或模型失败。
   * @example
   * const r7 = await engine.reinforceUpdated({ state: original, oldContent, newContent })
   */
  async reinforceUpdated(
    input: Parameters<DailyValueEngine["reinforceUpdated"]>[0],
  ): Promise<ValueState> {
    const state = decodeValueState(input.state)
    const oldContent = UnitContentSchema.safeParse(input.oldContent)
    const newContent = UnitContentSchema.safeParse(input.newContent)
    if (
      !oldContent.success ||
      !newContent.success ||
      oldContent.data.unitType !== newContent.data.unitType
    ) {
      throw new ValueEngineError("invalid-input", "正文格式无效或旧新单元类型不一致")
    }
    // 归档是终态，避免通过正文变化判断把已归档单元重新激活。
    if (this.forgetting.lifecycle(state) === "archived") {
      return input.state
    }
    const change = await this.changeJudge.judge(oldContent.data, newContent.data)
    // 正文分支独立于 R0：只复用 supplemented 的增益，不伪造一条用户反馈。
    if (change === "supplemented" || change === "state_updated") {
      return encodeValueState(this.forgetting.reinforce(state, "supplemented"))
    }
    return input.state
  }

  /**
   * 对选定的状态推进一个有效周期，更新 V、A 和连续低值计数。
   *
   * @param input 通常是原值/R0/R7 取大后的状态；归档状态保持不变。
   * @returns 新状态。对输出再次调用会再推进一周期；相同输入的计算结果相同。
   * @throws ValueEngineError 状态版本或数据无效。
   * @example
   * const final = engine.decay(engine.max(engine.max(original, r0), r7))
   */
  decay(input: ValueState): ValueState {
    return encodeValueState(this.forgetting.decayOneCycle(decodeValueState(input)))
  }

  /**
   * 比较同一单元的两个候选分支，选择保留价值更高的完整状态。
   *
   * @param a 第一个候选，通常是原值或上一次取大的结果。
   * @param b 第二个候选，通常是 R0 或 R7；不要传入不同单元的状态。
   * @returns a 或 b 原对象：依次取 V/S/P 更高、A/低值计数更小，完全同值时保留 a。
   * 不累加 R0/R7，也不把两个分支的字段拼成一个状态。
   * @throws ValueEngineError 任一候选的版本或数据无效。
   */
  max(a: ValueState, b: ValueState): ValueState {
    const left = decodeValueState(a)
    const right = decodeValueState(b)
    const order: readonly [keyof ValueData, number][] = [
      ["currentValue", 1],
      ["consolidationStrength", 1],
      ["peakValue", 1],
      ["activityCycles", -1],
      ["belowThresholdCycles", -1],
    ]
    // direction=1 表示数值更大优先；-1 表示周期计数更小优先。
    for (const [field, direction] of order) {
      const difference = (left[field] - right[field]) * direction
      if (difference !== 0) {
        return difference > 0 ? a : b
      }
    }
    return a
  }

  /**
   * 只读查询单元生命周期，不执行衰减或写入 Long。
   *
   * @param state 通常传入本次结算的最终状态。
   * @returns active / observing / archived；由已记录的连续低值计数与配置推导。
   * @throws ValueEngineError 状态版本或数据无效。
   * @example
   * const status = engine.lifecycle(final)
   */
  lifecycle(state: ValueState): LifecycleStatus {
    return this.forgetting.lifecycle(decodeValueState(state))
  }
}
