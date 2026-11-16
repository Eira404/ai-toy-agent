import type { LifecycleStatus, LongBlock, LongDetail, ValueState } from "toy-memory-long"
import { DailyMemoryError } from "../../error.js"
import { mapStage, type StageEnv } from "../../stage.js"
import { unitKey } from "../../unit.js"
import type { ConsolidationResult } from "../consolidate-value/types.js"
import type { FreezeBaseline } from "../freeze/types.js"
import type { BlockChangePlan } from "../generate/types.js"
import type { VerifyOutcome } from "../verify/types.js"
import type { SettledBlock, SettlementResult } from "./types.js"

/** 无价值引擎时，新建单元写入的占位价值状态。 */
const NO_VALUE_STATE: ValueState = { valueData: {}, valueVersion: "none" }

/**
 * 阶段七：价值结算与遗忘。
 *
 * 对每个 APPLY 块：
 * - 概述/细节是独立价值单元；INHERIT 单元走「R0（阶段零巩固）/ R7（正文更新强化）
 *   双路取大 + 统一衰减」，INITIALIZE 单元（新块/新细节）按重要程度初始化再衰减；
 * - lifecycle 由引擎从最终 valueData 解析（`lifecycle()`）。
 * 无价值引擎时：INHERIT 透传旧价值/旧生命周期，INITIALIZE 写 NO_VALUE_STATE + active。
 */
export async function runSettle(
  env: StageEnv,
  freezeBaseline: FreezeBaseline,
  consolidation: ConsolidationResult,
  verifyOutcomes: readonly VerifyOutcome[],
): Promise<SettlementResult> {
  const blockById = new Map(freezeBaseline.frozenLong.map((block) => [block.blockId, block]))
  const detailById = new Map<string, LongDetail>()
  for (const block of freezeBaseline.frozenLong) {
    for (const detail of block.details) {
      detailById.set(detail.detailId, detail)
    }
  }

  // 先分离 APPLY 与 LOCAL_ABANDON（各自保持相对顺序）
  const abandoned: BlockChangePlan[] = []
  const applyOutcomes: VerifyOutcome[] = []
  for (const outcome of verifyOutcomes) {
    if (outcome.verdict === "LOCAL_ABANDON") {
      abandoned.push(outcome.plan)
    } else {
      applyOutcomes.push(outcome)
    }
  }

  const settleOne = (outcome: VerifyOutcome): Promise<SettledBlock> =>
    settleBlock(env, outcome.plan, blockById, detailById, consolidation)

  // 并行结算各 APPLY 块；无并行执行器时（独立单元测试直接调用本函数）退回串行。
  const settled: SettledBlock[] =
    env.ctx?.parallelExecutor !== undefined
      ? await mapStage(env, applyOutcomes, settleOne, "settle")
      : await sequentialMap(applyOutcomes, settleOne)
  return { settled, abandoned }
}

async function settleBlock(
  env: StageEnv,
  plan: BlockChangePlan,
  blockById: ReadonlyMap<string, LongBlock>,
  detailById: ReadonlyMap<string, LongDetail>,
  consolidation: ConsolidationResult,
): Promise<SettledBlock> {
  const oldBlock = plan.kind === "UPDATE" ? blockById.get(plan.blockId) : undefined

  const overview = await settleOverview(env, plan, oldBlock, consolidation)

  const detailValues: { value: ValueState; lifecycle: LifecycleStatus }[] = []
  for (const op of plan.detailOps) {
    if (op.kind === "DELETE") {
      continue // 归档，不结算价值
    }
    if (op.kind === "CREATE") {
      detailValues.push(await settleNewDetail(env, plan, op.body))
      continue
    }
    const oldDetail = detailById.get(op.detailId)
    if (oldDetail === undefined) {
      throw new DailyMemoryError("invalid-input", `细节 '${op.detailId}' 不存在`)
    }
    detailValues.push(await settleDetail(env, oldDetail, op.summary, op.body, consolidation))
  }

  return {
    plan,
    overviewValue: overview.value,
    overviewLifecycle: overview.lifecycle,
    detailValues,
  }
}

async function settleOverview(
  env: StageEnv,
  plan: BlockChangePlan,
  oldBlock: LongBlock | undefined,
  consolidation: ConsolidationResult,
): Promise<{ value: ValueState; lifecycle: LifecycleStatus }> {
  const engine = env.valueEngine
  if (engine === undefined) {
    if (plan.kind === "CREATE") {
      return { value: NO_VALUE_STATE, lifecycle: "active" }
    }
    return { value: oldBlock!.value, lifecycle: oldBlock!.lifecycleStatus }
  }

  if (plan.kind === "CREATE") {
    const [initialized] = await engine.initialize([
      { unitType: "overview", domain: plan.domain, title: plan.title, body: plan.overviewBody },
    ])
    if (initialized === undefined) {
      throw new DailyMemoryError("invalid-input", "价值引擎 initialize 返回空结果")
    }
    const final = engine.decay(initialized)
    return { value: final, lifecycle: engine.lifecycle(final) }
  }

  const block = oldBlock!
  const r0 = consolidation.reinforced[unitKey("overview", plan.blockId)]
  const updated =
    block.title !== plan.title ||
    block.summary !== plan.summary ||
    block.overviewBody !== plan.overviewBody
  const r7 = updated
    ? await engine.reinforceUpdated({
        state: block.value,
        oldContent: {
          unitType: "overview",
          title: block.title,
          summary: block.summary,
          body: block.overviewBody,
        },
        newContent: {
          unitType: "overview",
          title: plan.title,
          summary: plan.summary,
          body: plan.overviewBody,
        },
      })
    : undefined
  const final = engine.decay(pickMax(engine, block.value, r0, r7))
  return { value: final, lifecycle: engine.lifecycle(final) }
}

async function settleDetail(
  env: StageEnv,
  oldDetail: LongDetail,
  summary: string,
  body: string,
  consolidation: ConsolidationResult,
): Promise<{ value: ValueState; lifecycle: LifecycleStatus }> {
  const engine = env.valueEngine
  if (engine === undefined) {
    return { value: oldDetail.value, lifecycle: oldDetail.lifecycleStatus }
  }

  const r0 = consolidation.reinforced[unitKey("detail", oldDetail.detailId)]
  const updated = oldDetail.summary !== summary || oldDetail.body !== body
  const r7 = updated
    ? await engine.reinforceUpdated({
        state: oldDetail.value,
        oldContent: { unitType: "detail", summary: oldDetail.summary, body: oldDetail.body },
        newContent: { unitType: "detail", summary, body },
      })
    : undefined
  const final = engine.decay(pickMax(engine, oldDetail.value, r0, r7))
  return { value: final, lifecycle: engine.lifecycle(final) }
}

/** 新建 detail（CREATE）：按重要程度初始化，再统一衰减。 */
async function settleNewDetail(
  env: StageEnv,
  plan: BlockChangePlan,
  body: string,
): Promise<{ value: ValueState; lifecycle: LifecycleStatus }> {
  const engine = env.valueEngine
  if (engine === undefined) {
    return { value: NO_VALUE_STATE, lifecycle: "active" }
  }
  const [initialized] = await engine.initialize([
    { unitType: "detail", domain: plan.domain, title: plan.title, body },
  ])
  if (initialized === undefined) {
    throw new DailyMemoryError("invalid-input", "价值引擎 initialize 返回空结果")
  }
  const final = engine.decay(initialized)
  return { value: final, lifecycle: engine.lifecycle(final) }
}

/** 双路取大：从 original 出发，逐项与 R0/R7 取价值更大者。 */
function pickMax(
  engine: NonNullable<StageEnv["valueEngine"]>,
  original: ValueState,
  r0: ValueState | undefined,
  r7: ValueState | undefined,
): ValueState {
  let best = original
  if (r0 !== undefined) {
    best = engine.max(best, r0)
  }
  if (r7 !== undefined) {
    best = engine.max(best, r7)
  }
  return best
}

/** 无并行执行器时的串行兜底（独立调用 `runSettle` 的单元测试场景）。 */
async function sequentialMap<T, R>(items: readonly T[], worker: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = []
  for (const item of items) {
    results.push(await worker(item))
  }
  return results
}
