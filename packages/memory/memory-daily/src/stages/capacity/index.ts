import { DailyMemoryError } from "../../error.js"
import { extractText } from "../../llm.js"
import { mapStage, type StageEnv } from "../../stage.js"
import type { LongBlock } from "toy-memory-long"
import type { BlockChangePlan, DetailOp } from "../generate/types.js"
import {
  buildDetailCapacityUserMessage,
  buildOverviewCapacityUserMessage,
  buildShortenUserMessage,
  STAGE_5_DETAIL_CAPACITY_SYSTEM_MESSAGE,
  STAGE_5_OVERVIEW_CAPACITY_SYSTEM_MESSAGE,
  STAGE_5_SHORTEN_SYSTEM_MESSAGE,
} from "./prompts.js"
import {
  detailCapacityJsonSchema,
  DetailCapacitySchema,
  type DetailCapacity,
  overviewCapacityJsonSchema,
  OverviewCapacitySchema,
  type OverviewCapacity,
  shortenJsonSchema,
  ShortenSchema,
} from "./schema.js"
import type { CapacityOutcome } from "./types.js"

// 容量阈值（LLM 目标 / 程序硬阈值），与 v2 §12.7 一致。
const BODY_TARGET = 300
const BODY_HARD = 400
const BODY_TARGET_TIGHT = 250
const TITLE_TARGET = 40
const TITLE_HARD = 60
const SUMMARY_TARGET = 80
const SUMMARY_HARD = 100
const DETAIL_BODY_TARGET = 250
const DETAIL_BODY_HARD = 350
const DETAIL_BODY_TARGET_TIGHT = 200
const DETAIL_SUMMARY_TARGET = 50
const DETAIL_SUMMARY_HARD = 70

type DetailCapacityOperation = DetailCapacity["operations"][number]

/**
 * 阶段五：模拟执行与容量整理。
 *
 * 两遍：
 * - 第一遍：overview body 超限 → LLM 重新精简并把非核心内容移入已有/新 detail；
 * - 第二遍：变化 detail body 超限 → LLM REWRITE（去重精简）或 SPLIT（拆多条）；
 * 之后单独处理短字段（title / summary / detail summary）。
 */
export async function runCapacity(
  env: StageEnv,
  plans: readonly BlockChangePlan[],
): Promise<CapacityOutcome[]> {
  return mapStage(env, plans, (plan) => fitPlan(env, plan), "capacity")
}

export async function fitPlan(env: StageEnv, plan: BlockChangePlan): Promise<CapacityOutcome> {
  const truncated: string[] = []
  const oldBlock = plan.kind === "UPDATE" ? await env.long.getBlock(env.scope, plan.blockId) : null

  // 第一遍：overview 溢出 → 精简 + 移出 detail
  const { overviewBody, newDetailOps } = await fitOverviewBody(env, plan, oldBlock, truncated)

  // 合并 detailOps（阶段四的 + 第一遍新增的）
  let detailOps: DetailOp[] = [...plan.detailOps, ...newDetailOps]

  // 第二遍：detail body 超限 → REWRITE / SPLIT / 截断
  detailOps = await fitDetailBodies(env, detailOps, truncated)

  // 短字段：title / summary
  const title = await fitField(env, "title", plan.title, TITLE_TARGET, TITLE_HARD, "title", truncated)
  const summary = await fitField(env, "summary", plan.summary, SUMMARY_TARGET, SUMMARY_HARD, "summary", truncated)

  // 短字段：detail summary
  detailOps = await fitDetailSummaries(env, detailOps, truncated)

  const fitted: BlockChangePlan = { ...plan, title, summary, overviewBody, detailOps }
  return { plan: fitted, truncatedFields: truncated }
}

/** 第一遍：overview body 超限时，LLM 精简 overview 并把移出的内容分配成 detail 操作。 */
async function fitOverviewBody(
  env: StageEnv,
  plan: BlockChangePlan,
  oldBlock: LongBlock | null,
  truncated: string[],
): Promise<{ overviewBody: string; newDetailOps: DetailOp[] }> {
  if (charCount(plan.overviewBody) < BODY_HARD) {
    return { overviewBody: plan.overviewBody, newDetailOps: [] }
  }

  const existingDetails = simulatedDetails(plan, oldBlock)
  let result = await callOverviewCapacity(env, plan, existingDetails, BODY_TARGET)
  if (charCount(result.overviewBody) >= BODY_HARD) {
    result = await callOverviewCapacity(env, plan, existingDetails, BODY_TARGET_TIGHT)
  }
  if (charCount(result.overviewBody) >= BODY_HARD) {
    truncated.push("overviewBody")
    result = { ...result, overviewBody: truncate(result.overviewBody, BODY_HARD) }
  }

  const newDetailOps: DetailOp[] = result.detailOperations.map((op) =>
    op.type === "UPDATE_EXISTING_DETAIL"
      ? { kind: "UPDATE", detailId: op.detailId, summary: op.summary, body: op.body }
      : { kind: "CREATE", summary: op.summary, body: op.body },
  )
  return { overviewBody: result.overviewBody, newDetailOps }
}

/** 第二遍：变化 detail body 超限 → UPDATE 走 REWRITE/SPLIT，CREATE 直接截断。 */
async function fitDetailBodies(
  env: StageEnv,
  detailOps: readonly DetailOp[],
  truncated: string[],
): Promise<DetailOp[]> {
  const updateOversized = detailOps.filter(
    (op): op is Extract<DetailOp, { kind: "UPDATE" }> =>
      op.kind === "UPDATE" && charCount(op.body) >= DETAIL_BODY_HARD,
  )
  if (updateOversized.length === 0) {
    return truncateCreateDetails(detailOps, truncated)
  }

  let operations = await callDetailCapacity(env, updateOversized, DETAIL_BODY_TARGET)
  if (detailCapacityAnyOver(operations, DETAIL_BODY_HARD)) {
    operations = await callDetailCapacity(env, updateOversized, DETAIL_BODY_TARGET_TIGHT)
  }

  const rewritten = new Map<string, { summary: string; body: string }>()
  const split = new Map<string, { summary: string; body: string }[]>()
  for (const operation of operations) {
    if (operation.type === "REWRITE") {
      rewritten.set(operation.detailId, {
        summary: operation.summary,
        body: truncateDetailBody(operation.body, operation.detailId, truncated),
      })
    } else {
      split.set(
        operation.detailId,
        operation.parts.map((part) => ({
          summary: part.summary,
          body: truncateDetailBody(part.body, operation.detailId, truncated),
        })),
      )
    }
  }

  const result: DetailOp[] = []
  for (const op of detailOps) {
    if (op.kind === "DELETE") {
      result.push(op)
      continue
    }
    if (op.kind === "CREATE") {
      result.push(truncateCreateDetail(op, truncated))
      continue
    }
    const rw = rewritten.get(op.detailId)
    if (rw !== undefined) {
      result.push({ kind: "UPDATE", detailId: op.detailId, summary: rw.summary, body: rw.body })
      continue
    }
    const parts = split.get(op.detailId)
    if (parts !== undefined) {
      for (let i = 0; i < parts.length; i++) {
        const part = parts[i]
        if (part === undefined) continue
        if (i === 0) {
          result.push({ kind: "UPDATE", detailId: op.detailId, summary: part.summary, body: part.body })
        } else {
          result.push({ kind: "CREATE", summary: part.summary, body: part.body })
        }
      }
      continue
    }
    result.push(op)
  }
  return result
}

/** 短字段：detail summary 超限时压缩。 */
async function fitDetailSummaries(
  env: StageEnv,
  detailOps: readonly DetailOp[],
  truncated: string[],
): Promise<DetailOp[]> {
  const result: DetailOp[] = []
  for (const op of detailOps) {
    if (op.kind === "DELETE") {
      result.push(op)
      continue
    }
    const fieldKey = op.kind === "UPDATE" ? `detail:${op.detailId}.summary` : "detail:create.summary"
    const summary = await fitField(
      env,
      "细节摘要",
      op.summary,
      DETAIL_SUMMARY_TARGET,
      DETAIL_SUMMARY_HARD,
      fieldKey,
      truncated,
    )
    result.push({ ...op, summary })
  }
  return result
}

/** 阶段四 + 旧块合成「模拟块」的已有细节（供 overview LLM 判断合并去向）。 */
function simulatedDetails(
  plan: BlockChangePlan,
  oldBlock: LongBlock | null,
): readonly { detailId: string; summary: string; body: string }[] {
  if (plan.kind === "CREATE" || oldBlock === null) {
    return []
  }
  const result: { detailId: string; summary: string; body: string }[] = []
  for (const detail of oldBlock.details) {
    const updateOp = plan.detailOps.find(
      (op): op is Extract<DetailOp, { kind: "UPDATE" }> =>
        op.kind === "UPDATE" && op.detailId === detail.detailId,
    )
    const deleteOp = plan.detailOps.find(
      (op): op is Extract<DetailOp, { kind: "DELETE" }> =>
        op.kind === "DELETE" && op.detailId === detail.detailId,
    )
    if (deleteOp !== undefined) {
      continue
    }
    if (updateOp !== undefined) {
      result.push({ detailId: detail.detailId, summary: updateOp.summary, body: updateOp.body })
    } else {
      result.push({ detailId: detail.detailId, summary: detail.summary, body: detail.body })
    }
  }
  return result
}

/** 调用 overview 容量 LLM。 */
async function callOverviewCapacity(
  env: StageEnv,
  plan: BlockChangePlan,
  existingDetails: readonly { detailId: string; summary: string; body: string }[],
  targetLength: number,
): Promise<OverviewCapacity> {
  const result = await env.ctx.llm.generate({
    provider: env.config.llmProvider,
    model: env.config.llmModel,
    messages: [
      { role: "system", content: [{ type: "text", text: STAGE_5_OVERVIEW_CAPACITY_SYSTEM_MESSAGE }] },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: buildOverviewCapacityUserMessage(
              plan.title,
              plan.summary,
              plan.overviewBody,
              charCount(plan.overviewBody),
              targetLength,
              existingDetails,
            ),
          },
        ],
      },
    ],
    responseFormat: { type: "json_schema", name: "overview_capacity", schema: overviewCapacityJsonSchema },
  })
  const text = extractText(result)
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new DailyMemoryError("invalid-input", "阶段五 overview 容量 LLM 输出不是合法 JSON", { cause: error })
  }
  return OverviewCapacitySchema.parse(parsed)
}

/** 调用 detail 容量 LLM。 */
async function callDetailCapacity(
  env: StageEnv,
  oversized: readonly Extract<DetailOp, { kind: "UPDATE" }>[],
  targetLength: number,
): Promise<readonly DetailCapacityOperation[]> {
  const details = oversized.map((op) => ({
    detailId: op.detailId,
    summary: op.summary,
    body: op.body,
    nowLength: charCount(op.body),
  }))
  const result = await env.ctx.llm.generate({
    provider: env.config.llmProvider,
    model: env.config.llmModel,
    messages: [
      { role: "system", content: [{ type: "text", text: STAGE_5_DETAIL_CAPACITY_SYSTEM_MESSAGE }] },
      {
        role: "user",
        content: [{ type: "text", text: buildDetailCapacityUserMessage(details, targetLength) }],
      },
    ],
    responseFormat: { type: "json_schema", name: "detail_capacity", schema: detailCapacityJsonSchema },
  })
  const text = extractText(result)
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new DailyMemoryError("invalid-input", "阶段五 detail 容量 LLM 输出不是合法 JSON", { cause: error })
  }
  return DetailCapacitySchema.parse(parsed).operations
}

/** 判断 detail 容量结果是否仍有超限 body。 */
function detailCapacityAnyOver(operations: readonly DetailCapacityOperation[], hard: number): boolean {
  return operations.some((op) =>
    op.type === "REWRITE"
      ? charCount(op.body) >= hard
      : op.parts.some((part) => charCount(part.body) >= hard),
  )
}

/** 截断单个 UPDATE/SPLIT 产生的 detail body。 */
function truncateDetailBody(body: string, detailId: string, truncated: string[]): string {
  if (charCount(body) >= DETAIL_BODY_HARD) {
    truncated.push(`detail:${detailId}.body`)
    return truncate(body, DETAIL_BODY_HARD)
  }
  return body
}

/** 无 UPDATE 超限时，只截断超限的 CREATE detail。 */
function truncateCreateDetails(detailOps: readonly DetailOp[], truncated: string[]): DetailOp[] {
  const result: DetailOp[] = []
  for (const op of detailOps) {
    result.push(op.kind === "CREATE" ? truncateCreateDetail(op, truncated) : op)
  }
  return result
}

function truncateCreateDetail(op: Extract<DetailOp, { kind: "CREATE" }>, truncated: string[]): DetailOp {
  if (charCount(op.body) >= DETAIL_BODY_HARD) {
    truncated.push("detail:create.body")
    return { ...op, body: truncate(op.body, DETAIL_BODY_HARD) }
  }
  return op
}

/** 单字段：超过硬阈值则 LLM 压缩，仍超则裁切并记录。 */
async function fitField(
  env: StageEnv,
  fieldLabel: string,
  content: string,
  target: number,
  hard: number,
  fieldKey: string,
  truncated: string[],
): Promise<string> {
  if (charCount(content) < hard) {
    return content
  }
  const shortened = await shortenField(env, fieldLabel, content, target)
  if (charCount(shortened) < hard) {
    return shortened
  }
  truncated.push(fieldKey)
  return truncate(shortened, hard)
}

/** 调 LLM 压缩单字段到目标字数。 */
async function shortenField(
  env: StageEnv,
  fieldLabel: string,
  content: string,
  target: number,
): Promise<string> {
  const result = await env.ctx.llm.generate({
    provider: env.config.llmProvider,
    model: env.config.llmModel,
    messages: [
      { role: "system", content: [{ type: "text", text: STAGE_5_SHORTEN_SYSTEM_MESSAGE }] },
      { role: "user", content: [{ type: "text", text: buildShortenUserMessage(fieldLabel, target, content) }] },
    ],
    responseFormat: { type: "json_schema", name: "shorten", schema: shortenJsonSchema },
  })

  const text = extractText(result)
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new DailyMemoryError("invalid-input", "阶段五压缩 LLM 输出不是合法 JSON", { cause: error })
  }
  return ShortenSchema.parse(parsed).content
}

/** 按 Unicode 码点计数，与 v2 的字符计数口径一致。 */
function charCount(value: string): number {
  return [...value].length
}

/** 兜底裁切：保留前 hard-1 个码点。 */
function truncate(value: string, hard: number): string {
  return [...value].slice(0, hard - 1).join("")
}
