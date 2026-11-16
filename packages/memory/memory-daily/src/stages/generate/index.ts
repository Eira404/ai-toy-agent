import type { LongBlock, LongDomain } from "toy-memory-long"
import { DailyMemoryError } from "../../error.js"
import { extractText } from "../../llm.js"
import { mapStage, type StageEnv } from "../../stage.js"
import type { CandidateAssignment } from "../assign/types.js"
import type { LongCandidate } from "../consolidate-cross/types.js"
import {
  buildCreateUserMessage,
  buildUpdateUserMessage,
  STAGE_4_CREATE_SYSTEM_MESSAGE,
  STAGE_4_UPDATE_SYSTEM_MESSAGE,
} from "./prompts.js"
import { blockGenerationJsonSchema, BlockGenerationSchema, type BlockGeneration } from "./schema.js"
import type { BlockChangePlan, DetailOp } from "./types.js"

/**
 * 阶段四：按目标块生成内容。
 *
 * 按 targetBlockId 聚合归属同一目标的候选（EXISTING 聚合到已有块，NEW 各自
 * 临时块），每个目标调用一次内容生成 LLM，产出 title/aliases/summary/overviewBody
 * 及（仅 UPDATE）detail 的 UPDATE/DELETE 操作。程序校验 detailId 存在、无重复、
 * 新块无细节操作。
 */
/** 阶段四按 targetBlockId 聚合出的目标分组。 */
interface TargetGroup {
  readonly targetKind: "EXISTING" | "NEW"
  readonly domain: LongDomain
  readonly candidates: LongCandidate[]
}

export async function runGenerate(
  env: StageEnv,
  longCandidates: readonly LongCandidate[],
  assignments: readonly CandidateAssignment[],
): Promise<BlockChangePlan[]> {
  const candidateById = new Map(longCandidates.map((candidate) => [candidate.candidateId, candidate]))

  // 按 targetBlockId 聚合
  const groups = new Map<string, TargetGroup>()
  for (const assignment of assignments) {
    const candidate = candidateById.get(assignment.candidateId)
    if (candidate === undefined) {
      throw new DailyMemoryError("invalid-input", `归属方案引用了未知候选 '${assignment.candidateId}'`)
    }
    const group = groups.get(assignment.targetBlockId)
    if (group === undefined) {
      groups.set(assignment.targetBlockId, {
        targetKind: assignment.targetKind,
        domain: assignment.domain,
        candidates: [candidate],
      })
    } else {
      group.candidates.push(candidate)
    }
  }

  // 每个目标生成一份变化方案（并行）
  return mapStage(
    env,
    [...groups.entries()],
    ([targetBlockId, group]) => generatePlanForTarget(env, targetBlockId, group),
    "generate",
  )
}

/** 为一个目标生成一份变化方案。 */
async function generatePlanForTarget(
  env: StageEnv,
  targetBlockId: string,
  group: TargetGroup,
): Promise<BlockChangePlan> {
  const sorted = [...group.candidates].sort((a, b) => a.candidateTime.localeCompare(b.candidateTime))
  const sourceFastIds = [...new Set(sorted.flatMap((candidate) => candidate.sourceFastIds))]

  if (group.targetKind === "EXISTING") {
    const oldBlock = await env.long.getBlock(env.scope, targetBlockId)
    if (oldBlock === null) {
      throw new DailyMemoryError("invalid-input", `目标块 '${targetBlockId}' 不存在`)
    }
    return generateUpdate(env, oldBlock, sorted, sourceFastIds)
  }
  return generateCreate(env, group.domain, sorted, sourceFastIds)
}

/** 生成新块：细节操作必须为空。 */
async function generateCreate(
  env: StageEnv,
  domain: LongDomain,
  candidates: LongCandidate[],
  sourceFastIds: readonly string[],
): Promise<BlockChangePlan> {
  const generation = await generateBlock(env, STAGE_4_CREATE_SYSTEM_MESSAGE, buildCreateUserMessage(candidates, domain))
  // 简化版不支持新块 detail CREATE：LLM 若返回 detailOperations，忽略之（不抛错，保证流程可继续）。
  return {
    kind: "CREATE",
    domain,
    title: generation.title,
    aliases: generation.aliases,
    summary: generation.summary,
    overviewBody: generation.overviewBody,
    detailOps: [],
    sourceFastIds,
    candidates,
  }
}

/** 更新已有块：校验 detail 操作引用真实 detailId、无重复。 */
async function generateUpdate(
  env: StageEnv,
  oldBlock: LongBlock,
  candidates: LongCandidate[],
  sourceFastIds: readonly string[],
): Promise<BlockChangePlan> {
  const generation = await generateBlock(env, STAGE_4_UPDATE_SYSTEM_MESSAGE, buildUpdateUserMessage(candidates, oldBlock))

  const detailIds = new Set(oldBlock.details.map((detail) => detail.detailId))
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

  return {
    kind: "UPDATE",
    blockId: oldBlock.blockId,
    domain: oldBlock.domain,
    title: generation.title,
    aliases: generation.aliases,
    summary: generation.summary,
    overviewBody: generation.overviewBody,
    detailOps,
    sourceFastIds,
    candidates,
  }
}

/** 调用内容生成 LLM 并解析校验。 */
async function generateBlock(
  env: StageEnv,
  systemMessage: string,
  userMessage: string,
): Promise<BlockGeneration> {
  const result = await env.ctx.llm.generate({
    provider: env.config.llmProvider,
    model: env.config.llmModel,
    messages: [
      { role: "system", content: [{ type: "text", text: systemMessage }] },
      { role: "user", content: [{ type: "text", text: userMessage }] },
    ],
    responseFormat: { type: "json_schema", name: "block_generation", schema: blockGenerationJsonSchema },
  })

  const text = extractText(result)
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new DailyMemoryError("invalid-input", "阶段四 LLM 输出不是合法 JSON", { cause: error })
  }
  return BlockGenerationSchema.parse(parsed)
}
