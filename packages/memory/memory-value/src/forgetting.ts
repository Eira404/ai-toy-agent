import type { FeedbackType } from "toy-memory-feedback"
import type { LifecycleStatus } from "toy-memory-long"
import {
  ForgettingConfigSchema,
  DEFAULT_FORGETTING_CONFIG,
  type ForgettingConfig,
} from "./config.js"
import { parseValueData, type ValueData } from "./state.js"
import { ImportanceLevelSchema, FeedbackTypeSchema, type ImportanceLevel } from "./schema.js"

/** 四档语义标签到 I 的固定映射；core=1 仍参与衰减，并非永久保留标记。 */
const IMPORTANCE_VALUES: Readonly<Record<ImportanceLevel, number>> = {
  low: 0.2,
  normal: 0.45,
  high: 0.7,
  core: 1,
}

/** consolidation 提高抗衰减能力 S，recovery 提高恢复峰值 P；它们不是直接加到 V 的分数。 */
const FEEDBACK_GAINS: Readonly<Record<FeedbackType, { consolidation: number; recovery: number }>> =
  {
    no_user_signal: { consolidation: 0, recovery: 0 },
    confirmed: { consolidation: 0.3, recovery: 0.55 },
    supplemented: { consolidation: 0.25, recovery: 0.5 },
    follow_up: { consolidation: 0.15, recovery: 0.35 },
    corrected: { consolidation: 0, recovery: 0 },
    irrelevant: { consolidation: 0, recovery: 0 },
    uncertain: { consolidation: 0, recovery: 0 },
  }

/** 从 mem-v0 迁移的确定性数值核心；不调用模型，不管理周期调度和存储。 */
export class ForgettingEngine {
  /** 完整且冻结的数值策略；一次状态序列应使用一致的策略。 */
  readonly config: Readonly<ForgettingConfig>

  /** @param config 完整数值配置，省略时复用旧版默认值；不接受只有部分字段的对象。 */
  constructor(config: ForgettingConfig = DEFAULT_FORGETTING_CONFIG) {
    this.config = Object.freeze(ForgettingConfigSchema.parse(config))
  }

  /**
   * 从已判定的重要性标签创建内部状态，不调用模型；常规业务使用 ValueEngine.initialize。
   * @param level low/normal/high/core 之一。
   * @returns S0=αI、P0=minPeak+(maxPeak-minPeak)I，A=0、V=P0、低值计数=0。
   */
  initialize(level: ImportanceLevel): ValueData {
    const intrinsicImportance = IMPORTANCE_VALUES[ImportanceLevelSchema.parse(level)]
    const peakValue =
      this.config.minimumPeak +
      (this.config.maximumPeak - this.config.minimumPeak) * intrinsicImportance
    return parseValueData({
      intrinsicImportance,
      consolidationStrength: this.config.initialConsolidationFactor * intrinsicImportance,
      peakValue,
      activityCycles: 0,
      currentValue: peakValue,
      belowThresholdCycles: 0,
    })
  }

  /**
   * 计算幂律公式 V=P(1+A)^(-d) 中的指数 d，不改变状态。
   * I 和 S 的保护越强，d 越小；d 是衰减指数，不是本周期从 V 中扣除的比例。
   * @param input 校验前的内部状态。
   * @returns minimumDecay + 重要性调整项 × 巩固保护项。
   */
  decayRate(input: ValueData): number {
    const state = parseValueData(input)
    return (
      this.config.minimumDecay +
      ((this.config.baseDecay - this.config.minimumDecay) /
        (1 + this.config.importanceProtection * state.intrinsicImportance)) *
        Math.pow(
          1 - this.config.consolidationProtection * state.consolidationStrength,
          this.config.consolidationExponent,
        )
    )
  }

  /**
   * 对内部状态应用一次用户态度对应的强化，不衰减、不改变重要性 I。
   * @param input 强化前的内部状态；观察态仍可强化，归档态保持原值。
   * @param feedbackType confirmed/supplemented/follow_up 提供正向增益，其余不强化。
   * @returns 有效强化时提高 S/P，并令 V=P、A=0、低值计数=0；输入对象保持不变。
   */
  reinforce(input: ValueData, feedbackType: FeedbackType): ValueData {
    const state = parseValueData(input)
    const gains = FEEDBACK_GAINS[FeedbackTypeSchema.parse(feedbackType)]
    if (
      this.lifecycle(state) === "archived" ||
      (gains.consolidation === 0 && gains.recovery === 0)
    ) {
      return state
    }
    // g 由当前 V 估计间隔效果：价值越低，重新得到正向证据时恢复越明显。
    // 不读取时钟；(1-S)/(1-P) 提供饱和增长，避免反复确认导致线性越界。
    const spacingGain =
      this.config.spacingFloor + (1 - this.config.spacingFloor) * (1 - state.currentValue)
    const consolidationStrength = clamp01(
      state.consolidationStrength +
        gains.consolidation * spacingGain * (1 - state.consolidationStrength),
    )
    const peakValue = clamp01(
      state.peakValue + gains.recovery * spacingGain * (1 - state.peakValue),
    )
    return parseValueData({
      ...state,
      consolidationStrength,
      peakValue,
      currentValue: peakValue,
      activityCycles: 0,
      belowThresholdCycles: 0,
    })
  }

  /**
   * 推进一个数值周期；幂律计算始终从峰值 P 出发，不对旧 V 再乘一次系数。
   * @param input 衰减前的内部状态。
   * @returns A 加一后的 V 和低值计数；归档状态不再推进。
   */
  decayOneCycle(input: ValueData): ValueData {
    const state = parseValueData(input)
    if (this.lifecycle(state) === "archived") {
      return state
    }
    const activityCycles = state.activityCycles + 1
    const currentValue = clamp01(
      state.peakValue * Math.pow(1 + activityCycles, -this.decayRate(state)),
    )
    return parseValueData({
      ...state,
      activityCycles,
      currentValue,
      // 只累计「连续」低值周期，达到/超过阈值时立即清零。
      belowThresholdCycles:
        currentValue < this.config.forgetThreshold ? state.belowThresholdCycles + 1 : 0,
    })
  }

  /**
   * 从已记录的连续低值计数推导生命周期，不执行新的阈值检测或衰减。
   * @returns 0=active，1..observationCycles-1=observing，达到观察周期数=archived。
   * 初始化和强化把计数置零；新的 V 是否低于阈值由 decayOneCycle 记录。
   */
  lifecycle(input: ValueData): LifecycleStatus {
    const state = parseValueData(input)
    if (state.belowThresholdCycles >= this.config.observationCycles) {
      return "archived"
    }
    return state.belowThresholdCycles > 0 ? "observing" : "active"
  }
}

/** 抑制浮点累计误差，保证强化后的归一化数值仍在 [0,1]。 */
function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value))
}
