import { randomUUID } from "node:crypto"
import type {
  LongBlock,
  LongBlockChange,
  LongBlockContent,
  LongDetailChange,
} from "toy-memory-long"
import { DailyMemoryError } from "../../error.js"
import { auditRow, spaceStateFromRow, spaceStateRow } from "../../relational.js"
import { DAILY_AUDITS_TABLE, DAILY_BATCHES_TABLE, DAILY_SPACE_STATE_TABLE } from "../../schema.js"
import { mapStage, type StageEnv } from "../../stage.js"
import { CHECKPOINT_STAGE } from "../../types.js"
import type { FreezeBaseline } from "../freeze/types.js"
import type { SettlementResult, SettledBlock } from "../settle/types.js"

/**
 * 阶段八：最终验证与原子提交（幂等多步提交）。
 *
 * 顺序：Long 变更（applyChanges）→ Fast 消费 → 反馈消费 → 审计/空间状态/批次落定。
 * 各包各自事务、各自幂等；整体由 `dailyBatchId` 与各包条件更新保证可重试。
 */
export async function runCommit(
  env: StageEnv,
  freezeBaseline: FreezeBaseline,
  settlement: SettlementResult,
): Promise<void> {
  // 1) Long 变更（逐块组装可并行：各自读旧块 + 生成向量）
  const blockById = new Map(freezeBaseline.frozenLong.map((block) => [block.blockId, block]))
  const changes = await mapStage(
    env,
    settlement.settled,
    (settled) => buildBlockChange(env, settled, blockById),
    "commit-build",
  )
  if (changes.length > 0) {
    await env.long.applyChanges(env.scope, { changes }, { idempotencyKey: env.batchId })
  }

  // 2) Fast 消费
  const fastIds = freezeBaseline.fastRecords.map((record) => record.fastId)
  if (fastIds.length > 0) {
    const plan = await env.fast.prepareConsumption({
      scope: env.scope,
      batchId: env.batchId,
      fastIds,
    })
    await env.fast.applyConsumption(plan)
  }

  // 3) 反馈消费
  const feedbackIds = freezeBaseline.frozenFeedback.map((feedback) => feedback.feedbackId)
  if (feedbackIds.length > 0) {
    await env.feedback.markConsolidated(env.scope, env.batchId, feedbackIds)
  }

  // 4) 审计 + 空间状态 + 批次成功
  await writeAudits(env, settlement)
  await updateSpaceState(env)
  await markBatchSucceeded(env)
}

/** 把一个已结算块组装为 LongBlockChange（含 summary 向量）。 */
async function buildBlockChange(
  env: StageEnv,
  settled: SettledBlock,
  blockById: ReadonlyMap<string, LongBlock>,
): Promise<LongBlockChange> {
  const plan = settled.plan
  const oldBlock = plan.kind === "UPDATE" ? blockById.get(plan.blockId) : undefined
  const oldDetailById = new Map((oldBlock?.details ?? []).map((detail) => [detail.detailId, detail]))

  // 需要 embed 的 summary：块 summary + 所有非 DELETE detail summary
  const nonDeleteOps = plan.detailOps.filter((op) => op.kind !== "DELETE")
  const texts = [plan.summary, ...nonDeleteOps.map((op) => op.summary)]
  const vectors = await embedTexts(env, texts)
  const summaryVector = vectors[0]
  if (summaryVector === undefined) {
    throw new DailyMemoryError("invalid-input", "块 summary Embedding 返回空")
  }

  const content: LongBlockContent = {
    domain: plan.domain,
    title: plan.title,
    aliases: plan.aliases,
    summary: plan.summary,
    overviewBody: plan.overviewBody,
    lifecycleStatus: settled.overviewLifecycle,
  }

  const details: LongDetailChange[] = []
  let nonDeleteIndex = 0
  for (const op of plan.detailOps) {
    if (op.kind === "DELETE") {
      const oldDetail = oldDetailById.get(op.detailId)
      if (oldDetail === undefined) {
        throw new DailyMemoryError("invalid-input", `细节 '${op.detailId}' 不存在`)
      }
      details.push({ kind: "ARCHIVE", detailId: op.detailId, oldValue: oldDetail.value })
      continue
    }
    const settlement = settled.detailValues[nonDeleteIndex]
    const detailVector = vectors[nonDeleteIndex + 1]
    if (settlement === undefined || detailVector === undefined) {
      throw new DailyMemoryError("invalid-input", "细节的向量或结算缺失")
    }
    if (op.kind === "UPDATE") {
      const oldDetail = oldDetailById.get(op.detailId)
      if (oldDetail === undefined) {
        throw new DailyMemoryError("invalid-input", `细节 '${op.detailId}' 不存在`)
      }
      details.push({
        kind: "UPDATE",
        detailId: op.detailId,
        oldSummary: oldDetail.summary,
        oldBody: oldDetail.body,
        oldValue: oldDetail.value,
        summary: op.summary,
        summaryVector: detailVector,
        body: op.body,
        lifecycleStatus: settlement.lifecycle,
        value: settlement.value,
      })
    } else {
      details.push({
        kind: "CREATE",
        summary: op.summary,
        summaryVector: detailVector,
        body: op.body,
        lifecycleStatus: settlement.lifecycle,
        value: settlement.value,
      })
    }
    nonDeleteIndex += 1
  }

  if (plan.kind === "CREATE") {
    return { kind: "CREATE", content, summaryVector, value: settled.overviewValue, details }
  }

  return {
    kind: "UPDATE",
    blockId: plan.blockId,
    oldContent: {
      domain: oldBlock!.domain,
      title: oldBlock!.title,
      aliases: oldBlock!.aliases,
      summary: oldBlock!.summary,
      overviewBody: oldBlock!.overviewBody,
      lifecycleStatus: oldBlock!.lifecycleStatus,
    },
    oldValue: oldBlock!.value,
    content,
    summaryVector,
    value: settled.overviewValue,
    details,
  }
}

/** 批量生成 summary 向量。 */
async function embedTexts(env: StageEnv, texts: readonly string[]): Promise<readonly (readonly number[])[]> {
  if (texts.length === 0) {
    return []
  }
  const result = await env.ctx.embedding.embed({
    provider: env.config.embeddingProvider,
    model: env.config.embeddingModel,
    texts,
    operation: "memory-daily-commit",
  })
  return result.vectors
}

/** 写阶段八审计（APPLY + LOCAL_ABANDON）。 */
async function writeAudits(env: StageEnv, settlement: SettlementResult): Promise<void> {
  const now = env.config.now()
  for (const settled of settlement.settled) {
    const targetBlockId = settled.plan.kind === "UPDATE" ? settled.plan.blockId : null
    await env.relational.execute({
      type: "insert",
      table: DAILY_AUDITS_TABLE,
      value: auditRow({
        auditId: randomUUID(),
        batchId: env.batchId,
        memorySpaceId: env.scope.memorySpaceId,
        targetBlockId,
        result: "APPLY",
        sourceFastIds: settled.plan.sourceFastIds,
        createdAt: now,
      }),
    })
  }
  for (const abandoned of settlement.abandoned) {
    const targetBlockId = abandoned.kind === "UPDATE" ? abandoned.blockId : null
    await env.relational.execute({
      type: "insert",
      table: DAILY_AUDITS_TABLE,
      value: auditRow({
        auditId: randomUUID(),
        batchId: env.batchId,
        memorySpaceId: env.scope.memorySpaceId,
        targetBlockId,
        result: "LOCAL_ABANDON",
        sourceFastIds: abandoned.sourceFastIds,
        createdAt: now,
      }),
    })
  }
}

/** 成功 Daily 计数 +1，并记录 last_daily_at。 */
async function updateSpaceState(env: StageEnv): Promise<void> {
  const now = env.config.now()
  const currentResult = await env.relational.execute({
    type: "get",
    table: DAILY_SPACE_STATE_TABLE,
    key: env.scope.memorySpaceId,
  })
  const current = currentResult.row === undefined ? null : spaceStateFromRow(currentResult.row)

  await env.relational.execute({
    type: "upsert",
    table: DAILY_SPACE_STATE_TABLE,
    value: spaceStateRow({
      memorySpaceId: env.scope.memorySpaceId,
      userId: env.scope.userId,
      successfulDailyCount: (current?.successfulDailyCount ?? 0) + 1,
      lastDailyAt: now,
      lastWeeklyAt: current?.lastWeeklyAt ?? null,
      createdAt: current?.createdAt ?? now,
      updatedAt: now,
    }),
  })
}

/** 批次置为 succeeded。 */
async function markBatchSucceeded(env: StageEnv): Promise<void> {
  const now = env.config.now()
  await env.relational.execute({
    type: "update",
    table: DAILY_BATCHES_TABLE,
    where: { type: "eq", field: "batch_id", value: env.batchId },
    patch: {
      status: "succeeded",
      checkpoint_stage: CHECKPOINT_STAGE.commit,
      committed_at: now,
      finished_at: now,
      updated_at: now,
    },
  })
}
