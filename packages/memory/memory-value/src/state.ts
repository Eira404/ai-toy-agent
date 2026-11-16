import { z } from "zod"
import type { ValueState } from "toy-memory-long"
import { ValueEngineError } from "./error.js"

/** 数值 JSON 的格式/算法版本；与反馈 JSON 的 JUDGEMENT_VERSION 分别管理。 */
export const VALUE_VERSION = "forgetting-v1"

const unitInterval = z.number().finite().min(0).max(1)

/**
 * 本引擎拥有的持久化价值 JSON。外部记忆服务只按 ValueState 原样存取。
 * 生命周期由连续低值计数推导，不重复保存；范围校验之外还检查 V≤P、低值周期≤A。
 */
export const ValueDataSchema = z
  .object({
    /** I：内容内在重要性，[0,1]；初始化选档后不随反馈或正文强化改变。 */
    intrinsicImportance: unitInterval,
    /** S：正向反馈积累的巩固强度，[0,1]；越高，后续衰减越慢。 */
    consolidationStrength: unitInterval,
    /** P：最近初始化/强化的恢复峰值，[0,1]；当前价值从该峰值按周期计算。 */
    peakValue: unitInterval,
    /** A：初始化或最近一次有效强化以来的周期数，非单元终身累计周期数。 */
    activityCycles: z.number().int().nonnegative().safe(),
    /** V：当前保留价值，[0,P]；不是事实可信度或检索相关性分数。 */
    currentValue: unitInterval,
    /** 最近连续低于阈值的周期数；回到阈值以上或有效强化时归零。 */
    belowThresholdCycles: z.number().int().nonnegative().safe(),
  })
  .strict()
  .superRefine((state, ctx) => {
    if (state.currentValue > state.peakValue) {
      ctx.addIssue({ code: "custom", path: ["currentValue"], message: "当前价值不能超过峰值" })
    }
    if (state.belowThresholdCycles > state.activityCycles) {
      ctx.addIssue({
        code: "custom",
        path: ["belowThresholdCycles"],
        message: "低值周期数不能超过活动周期数",
      })
    }
  })

/** 由 Schema 推导的引擎内部状态；通常通过 decodeValueState 获取，不手工拼写。 */
export type ValueData = z.infer<typeof ValueDataSchema>

/**
 * 校验一份不带版本外壳的数值 JSON，并返回解析后的对象副本。
 * @param input 待检查的未知 JSON；主要供数值核心内部使用。
 * @throws ValueEngineError invalid-state：字段缺失、多余、越界或计数不一致。
 */
export function parseValueData(input: unknown): ValueData {
  const parsed = ValueDataSchema.safeParse(input)
  if (!parsed.success) {
    throw new ValueEngineError("invalid-state", "价值状态格式无效", { cause: parsed.error })
  }
  return parsed.data
}

/**
 * 检查 ValueState 版本并解析内部六个数值字段，适合算法入口或调试展示。
 * @param input Long 存取的 valueVersion/valueData 外壳。
 * @returns 校验后的内部状态副本；外部业务不应依赖其字段重新计算价值。
 * @throws ValueEngineError unsupported-value-version（包括 none）或 invalid-state。
 * @example
 * const { currentValue, activityCycles } = decodeValueState(state)
 */
export function decodeValueState(input: ValueState): ValueData {
  if (input.valueVersion !== VALUE_VERSION) {
    throw new ValueEngineError(
      "unsupported-value-version",
      `不支持价值版本 '${input.valueVersion}'；需先迁移或初始化`,
    )
  }
  return parseValueData(input.valueData)
}

/**
 * 校验内部状态并添加当前 VALUE_VERSION 外壳，不执行初始化、强化、衰减或落库。
 * @param input 已由数值核心计算出的完整内部状态。
 * @returns 可交回 Long 存取的 ValueState，内部数据是解析后的副本。
 * @throws ValueEngineError invalid-state。
 */
export function encodeValueState(input: ValueData): ValueState {
  return { valueVersion: VALUE_VERSION, valueData: parseValueData(input) }
}
