import type { LongBlock } from "toy-memory-long"
import { DailyMemoryError } from "../../error.js"
import { extractText } from "../../llm.js"
import { mapStage, type StageEnv } from "../../stage.js"
import { fitPlan } from "../capacity/index.js"
import type { CapacityOutcome } from "../capacity/types.js"
import type { BlockChangePlan, DetailOp } from "../generate/types.js"
import { BlockGenerationSchema, blockGenerationJsonSchema, type BlockGeneration } from "../generate/schema.js"
import {
  buildRepairUserMessage,
  buildVerifyUserMessage,
  STAGE_6_REPAIR_SYSTEM_MESSAGE,
  STAGE_6_VERIFY_SYSTEM_MESSAGE,
} from "./prompts.js"
import {
  VerifyOutputSchema,
  verifyJsonSchema,
  type VerifyIssueType,
  type VerifyOutput,
} from "./schema.js"
import type { VerifyOutcome } from "./types.js"

type VerifyIssue = {
  type: VerifyIssueType
  field: string
  snippet: string
  evidence: string
  suggestion: string
}

/**
 * 阶段六：独立验证、修正与局部放弃。
 *
 * 每个目标块先验证，过滤由 capacityTruncated 导致的 MISSING；有剩余问题则修正
 * 一轮并重新验证；仍失败则 LOCAL_ABANDON。简化版：最多一轮修正（v2 是两轮）。
 */
export async function runVerify(
  env: StageEnv,
  capacityOutcomes: readonly CapacityOutcome[],
): Promise<VerifyOutcome[]> {
  return mapStage(env, capacityOutcomes, (outcome) => verifyTarget(env, outcome), "verify")
}

async function verifyTarget(env: StageEnv, outcome: CapacityOutcome): Promise<VerifyOutcome> {
  const { plan, truncatedFields } = outcome

  const issues = await verifyOnce(env, plan, truncatedFields)
  if (issues.length === 0) {
    return { verdict: "APPLY", plan }
  }

  // 修正一轮 → 回阶段五容量整理（单条直接 fit，避免经任务池同池重入）→ 再验证
  const repaired = await repairOnce(env, plan, issues)
  const refitted = await fitPlan(env, repaired)
  const reIssues = await verifyOnce(env, refitted.plan, refitted.truncatedFields)
  if (reIssues.length === 0) {
    return { verdict: "APPLY", plan: refitted.plan }
  }

  return { verdict: "LOCAL_ABANDON", plan }
}

/** 一次验证：返回过滤后的剩余问题（空数组表示通过）。 */
async function verifyOnce(
  env: StageEnv,
  plan: BlockChangePlan,
  truncatedFields: readonly string[],
): Promise<VerifyIssue[]> {
  const oldBlock = await loadOldBlock(env, plan)
  const result = await env.ctx.llm.generate({
    provider: env.config.llmProvider,
    model: env.config.llmModel,
    messages: [
      { role: "system", content: [{ type: "text", text: STAGE_6_VERIFY_SYSTEM_MESSAGE }] },
      { role: "user", content: [{ type: "text", text: buildVerifyUserMessage(plan, oldBlock, truncatedFields) }] },
    ],
    responseFormat: { type: "json_schema", name: "verify", schema: verifyJsonSchema },
  })
  const output = parseVerify(extractText(result))
  if (output.verdict === "PASS") {
    return []
  }
  // 过滤由程序裁切导致的 MISSING
  return output.issues.filter(
    (issue) => !(issue.type === "MISSING" && truncatedFields.includes(issue.field)),
  )
}

/** 一次修正：重新生成完整块，返回新的变化方案。 */
async function repairOnce(
  env: StageEnv,
  plan: BlockChangePlan,
  issues: readonly VerifyIssue[],
): Promise<BlockChangePlan> {
  const oldBlock = await loadOldBlock(env, plan)
  const result = await env.ctx.llm.generate({
    provider: env.config.llmProvider,
    model: env.config.llmModel,
    messages: [
      { role: "system", content: [{ type: "text", text: STAGE_6_REPAIR_SYSTEM_MESSAGE }] },
      { role: "user", content: [{ type: "text", text: buildRepairUserMessage(plan, oldBlock, issues) }] },
    ],
    responseFormat: { type: "json_schema", name: "repair", schema: blockGenerationJsonSchema },
  })

  let parsed: unknown
  try {
    parsed = JSON.parse(extractText(result))
  } catch (error) {
    throw new DailyMemoryError("invalid-input", "阶段六修正 LLM 输出不是合法 JSON", { cause: error })
  }
  return buildPlanFromGeneration(plan, BlockGenerationSchema.parse(parsed), oldBlock)
}

/** 读旧块：CREATE 无旧块，UPDATE 读冻结旧块。 */
async function loadOldBlock(env: StageEnv, plan: BlockChangePlan): Promise<LongBlock | null> {
  if (plan.kind === "CREATE") {
    return null
  }
  const block = await env.long.getBlock(env.scope, plan.blockId)
  if (block === null) {
    throw new DailyMemoryError("invalid-input", `目标块 '${plan.blockId}' 不存在`)
  }
  return block
}

/** 把修正后的 BlockGeneration 转回 BlockChangePlan（校验 detail 操作）。 */
function buildPlanFromGeneration(
  plan: BlockChangePlan,
  generation: BlockGeneration,
  oldBlock: LongBlock | null,
): BlockChangePlan {
  const base = {
    title: generation.title,
    aliases: generation.aliases,
    summary: generation.summary,
    overviewBody: generation.overviewBody,
  }

  if (plan.kind === "CREATE") {
    // 简化版不支持新块 detail CREATE：忽略 LLM 返回的 detailOperations。
    return { ...plan, ...base }
  }

  const detailIds = new Set(oldBlock?.details.map((detail) => detail.detailId) ?? [])
  const detailOps: DetailOp[] = []
  for (const op of generation.detailOperations) {
    if (!detailIds.has(op.detailId)) {
      throw new DailyMemoryError("invalid-input", `细节操作引用了不存在的 detailId '${op.detailId}'`)
    }
    if (detailOps.some((existing) => existing.kind !== "CREATE" && existing.detailId === op.detailId)) {
      throw new DailyMemoryError("invalid-input", `细节 '${op.detailId}' 有重复操作`)
    }
    detailOps.push(
      op.operation.type === "UPDATE"
        ? { kind: "UPDATE", detailId: op.detailId, summary: op.operation.summary, body: op.operation.body }
        : { kind: "DELETE", detailId: op.detailId },
    )
  }
  return { ...plan, ...base, detailOps }
}

function parseVerify(text: string): VerifyOutput {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new DailyMemoryError("invalid-input", "阶段六验证 LLM 输出不是合法 JSON", { cause: error })
  }
  return VerifyOutputSchema.parse(parsed)
}
