import { z } from "zod"

const unitInterval = z.number().finite().min(0).max(1)

/** 仅包含单元数值计算参数；活动周期是否成立由调用方决定。 */
export const ForgettingConfigSchema = z
  .object({
    /** 初始巩固比例 α，S0=α×I；范围 [0,1]，默认 0.1。 */
    initialConsolidationFactor: unitInterval,
    /** 初始化峰值的下界；P0=minimumPeak+(maximumPeak-minimumPeak)×I，默认 0.45。 */
    minimumPeak: unitInterval,
    /** 初始化峰值的上界，默认 0.85；强化后的 P 可以继续增长至 1。 */
    maximumPeak: unitInterval,
    /** 衰减指数 d 的正下界，默认 0.05；越小表示最低衰减速度越慢。 */
    minimumDecay: unitInterval.gt(0),
    /** 未施加重要性与巩固保护时的基础衰减指数，默认 0.78。 */
    baseDecay: unitInterval,
    /** 重要性 I 对衰减指数的保护系数，默认 0.85；越大保护越强。 */
    importanceProtection: unitInterval,
    /** 巩固强度 S 对衰减指数的保护系数，默认 1。 */
    consolidationProtection: unitInterval,
    /** 巩固保护项 (1-consolidationProtection×S) 的指数，范围 (0,1]，默认 1。 */
    consolidationExponent: unitInterval.gt(0),
    /** 间隔强化增益 g 的最低值，默认 0.2；不代表实际时间间隔。 */
    spacingFloor: unitInterval,
    /** 衰减后 V 严格低于该值才累计低值周期，默认 0.18。 */
    forgetThreshold: unitInterval,
    /** 连续低值达到该周期数后归档，默认 7；单位是调用方推进的周期，不是天。 */
    observationCycles: z.number().int().positive().safe(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.minimumPeak > value.maximumPeak) {
      ctx.addIssue({
        code: "custom",
        path: ["minimumPeak"],
        message: "minimumPeak 不能超过 maximumPeak",
      })
    }
    if (value.minimumDecay > value.baseDecay) {
      ctx.addIssue({
        code: "custom",
        path: ["minimumDecay"],
        message: "minimumDecay 不能超过 baseDecay",
      })
    }
  })

/** 完整数值策略；数值核心直接构造时传完整配置，插件可通过 forgetting 部分覆盖。 */
export type ForgettingConfig = z.infer<typeof ForgettingConfigSchema>

/** 旧版算法默认参数；已冻结，不包含活动量统计或调度参数。 */
export const DEFAULT_FORGETTING_CONFIG: Readonly<ForgettingConfig> = Object.freeze({
  initialConsolidationFactor: 0.1,
  minimumPeak: 0.45,
  maximumPeak: 0.85,
  minimumDecay: 0.05,
  baseDecay: 0.78,
  importanceProtection: 0.85,
  consolidationProtection: 1,
  consolidationExponent: 1,
  spacingFloor: 0.2,
  forgetThreshold: 0.18,
  observationCycles: 7,
})

/** MemoryValue 插件或 ValueEngine 构造参数；三个语义判断器共用一条模型路由。 */
export interface MemoryValueConfig {
  /** 已注册在 ctx.llm 中的 provider/降级链名称，必填。 */
  readonly llmProvider: string
  /** 模型名称，必填；按 provider 的协议解释。 */
  readonly llmModel: string
  /** 非负有限数，默认 0；用于降低分类结果的随机性，不保证模型完全确定。 */
  readonly temperature?: number
  /** 每次结构化判断的最大输出 token 数，正整数，默认 2048。 */
  readonly maxTokens?: number
  /** 数值策略部分覆盖；未指定字段沿用 DEFAULT_FORGETTING_CONFIG。 */
  readonly forgetting?: Partial<ForgettingConfig>
}

/** 合并默认值、裁剪路由边界空白并完成校验后的固定配置。 */
export interface ResolvedMemoryValueConfig {
  /** 已校验的 LLM provider/降级链名称。 */
  readonly llmProvider: string
  /** 已校验的模型名称。 */
  readonly llmModel: string
  /** 实际发送给三个判断器的温度。 */
  readonly temperature: number
  /** 实际发送给三个判断器的输出 token 上限。 */
  readonly maxTokens: number
  /** 完整且冻结的数值策略；已有状态应保持相同策略解释。 */
  readonly forgetting: Readonly<ForgettingConfig>
}

/**
 * 合并默认值并冻结配置；通常由 ValueEngine 构造函数自动调用。
 * @param config 用户配置；不会修改原对象。
 * @returns 顶层及 forgetting 均冻结的完整配置。
 * @throws Zod 校验错误：路由为空、数值越界或 minimum/maximum 关系无效。
 */
export function resolveMemoryValueConfig(config: MemoryValueConfig): ResolvedMemoryValueConfig {
  return Object.freeze({
    llmProvider: z.string().trim().min(1).parse(config.llmProvider),
    llmModel: z.string().trim().min(1).parse(config.llmModel),
    temperature: z
      .number()
      .finite()
      .nonnegative()
      .parse(config.temperature ?? 0),
    maxTokens: z
      .number()
      .int()
      .positive()
      .safe()
      .parse(config.maxTokens ?? 2048),
    forgetting: Object.freeze(
      ForgettingConfigSchema.parse({ ...DEFAULT_FORGETTING_CONFIG, ...config.forgetting }),
    ),
  })
}
