import type { FeedbackJudgement } from "toy-memory-feedback"
import type { ValueState } from "toy-memory-long"
import type { StageEnv } from "../../stage.js"
import { unitKey } from "../../unit.js"
import type { FreezeBaseline } from "../freeze/types.js"
import type { ConsolidationResult } from "./types.js"

/**
 * 阶段零：记忆巩固价值计算。
 *
 * 从冻结反馈中取出「被检索到的价值单元」，连同冻结 Long 里这些单元的当前价值，
 * 逐单元提交给价值引擎 `settle`，得到巩固后的价值（R0），暂存于 checkpoint，
 * 供阶段七在正文更新强化（R7）时取大。无价值引擎时跳过，返回空结果。
 */
export async function runConsolidateValue(
  env: StageEnv,
  baseline: FreezeBaseline,
): Promise<ConsolidationResult> {
  const engine = env.valueEngine
  if (engine === undefined) {
    return { reinforced: {}, skipped: [] }
  }

  // 1) 建 unitKey → 当前价值 索引（从冻结 Long 快照：块概述 + 各细节）
  const valueByUnit = new Map<string, ValueState>()
  for (const block of baseline.frozenLong) {
    valueByUnit.set(unitKey("overview", block.blockId), block.value)
    for (const detail of block.details) {
      valueByUnit.set(unitKey("detail", detail.detailId), detail.value)
    }
  }

  // 2) 按 unitKey 聚合反馈判断（同一单元多 Session 按 createdAt 升序）
  const judgementsByUnit = new Map<string, FeedbackJudgement[]>()
  const sorted = [...baseline.frozenFeedback].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  for (const outcome of sorted) {
    const key = unitKey(outcome.unitType, outcome.unitId)
    const list = judgementsByUnit.get(key) ?? []
    list.push(outcome) // FeedbackOutcome 是 FeedbackJudgement 的子类型
    judgementsByUnit.set(key, list)
  }

  // 3) 逐单元巩固：settle(原值, judgements) → R0
  const reinforced: Record<string, ValueState> = {}
  const skipped: string[] = []
  for (const [key, judgements] of judgementsByUnit) {
    const original = valueByUnit.get(key)
    if (original === undefined) {
      skipped.push(key) // 反馈引用的单元已归档/删除，跳过
      continue
    }
    reinforced[key] = engine.settle({ state: original, judgements })
  }

  return { reinforced, skipped }
}
