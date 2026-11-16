import { randomUUID } from "node:crypto"
import type { SessionCandidate } from "../consolidate-session/types.js"
import { DailyMemoryError } from "../../error.js"
import { mapStage, type StageEnv } from "../../stage.js"
import {
  buildConsolidationUserMessage,
  buildGroupingUserMessage,
  STAGE_2_CONSOLIDATION_SYSTEM_MESSAGE,
  STAGE_2_GROUPING_SYSTEM_MESSAGE,
} from "./prompts.js"
import {
  crossConsolidationJsonSchema,
  CrossConsolidationOutputSchema,
  groupingJsonSchema,
  GroupingOutputSchema,
} from "./schema.js"
import type { LongCandidate } from "./types.js"

/** 阶段一候选 + 分配的本批唯一 ID。 */
interface IndexedCandidate extends SessionCandidate {
  readonly candidateId: string
}

/**
 * 阶段二：跨 Session 整理。
 *
 * 先给每条 Session 候选分配 candidateId，用分组 LLM（candidateId+title+summary）
 * 判断哪些可能属于同一对象/主题，校验分组是完整分区后，逐组做内容整合 LLM
 * （title/summary/body/candidateTime）得到 Long 候选，并程序附加 candidateTime
 * （组内最晚）与 sourceFastIds（组内并集）。
 *
 * 简化版：分组 LLM 与组内整合都只调用一次；超容量时的切分与两轮归并未实现（TODO）。
 */
export async function runConsolidateCross(
  env: StageEnv,
  sessionCandidates: readonly SessionCandidate[],
): Promise<LongCandidate[]> {
  if (sessionCandidates.length === 0) {
    return []
  }

  // 1) 分配 candidateId
  const indexed: IndexedCandidate[] = sessionCandidates.map((candidate) => ({
    ...candidate,
    candidateId: randomUUID(),
  }))
  const byId = new Map(indexed.map((candidate) => [candidate.candidateId, candidate]))

  // 2) 分组 LLM + 分区校验
  const groups = await groupCandidates(env, indexed)
  assertCompletePartition(groups, new Set(indexed.map((candidate) => candidate.candidateId)))

  // 3) 组内内容整合（并行）
  const perGroup = await mapStage(
    env,
    groups,
    (group) => consolidateGroup(env, group.candidateIds.map((id) => byId.get(id)!)),
    "consolidate-cross",
  )
  return perGroup.flat()
}

/** 分组 LLM：candidateId + title + summary → 分组列表。 */
async function groupCandidates(
  env: StageEnv,
  indexed: readonly IndexedCandidate[],
): Promise<readonly { candidateIds: readonly string[] }[]> {
  const candidatesStr = indexed
    .map((candidate) => `CandidateId:${candidate.candidateId}\nTitle:${candidate.title}\nSummary:${candidate.summary}`)
    .join("\n---\n")

  const result = await env.ctx.llm.generate({
    provider: env.config.llmProvider,
    model: env.config.llmModel,
    messages: [
      { role: "system", content: [{ type: "text", text: STAGE_2_GROUPING_SYSTEM_MESSAGE }] },
      { role: "user", content: [{ type: "text", text: buildGroupingUserMessage(candidatesStr) }] },
    ],
    responseFormat: { type: "json_schema", name: "cross_grouping", schema: groupingJsonSchema },
  })

  const text = extractText(result)
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new DailyMemoryError("invalid-input", "阶段二分组 LLM 输出不是合法 JSON", { cause: error })
  }
  return GroupingOutputSchema.parse(parsed).groups
}

/** 组内整合 LLM：title/summary/body/candidateTime → title/summary/body。 */
async function consolidateGroup(
  env: StageEnv,
  members: IndexedCandidate[],
): Promise<LongCandidate[]> {
  const sorted = [...members].sort((a, b) => a.candidateTime.localeCompare(b.candidateTime))
  const latestTime = sorted.at(-1)?.candidateTime ?? ""
  const candidatesStr = sorted
    .map(
      (candidate) =>
        `Time:${candidate.candidateTime}\nTitle:${candidate.title}\nSummary:${candidate.summary}\nBody:${candidate.body}`,
    )
    .join("\n---\n")

  const result = await env.ctx.llm.generate({
    provider: env.config.llmProvider,
    model: env.config.llmModel,
    messages: [
      { role: "system", content: [{ type: "text", text: STAGE_2_CONSOLIDATION_SYSTEM_MESSAGE }] },
      { role: "user", content: [{ type: "text", text: buildConsolidationUserMessage(candidatesStr) }] },
    ],
    responseFormat: {
      type: "json_schema",
      name: "cross_consolidation",
      schema: crossConsolidationJsonSchema,
    },
  })

  const text = extractText(result)
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new DailyMemoryError("invalid-input", "阶段二整合 LLM 输出不是合法 JSON", { cause: error })
  }
  const validated = CrossConsolidationOutputSchema.parse(parsed)

  const sourceFastIds = [...new Set(sorted.flatMap((candidate) => candidate.sourceFastIds))]
  return validated.memories.map((memory) => ({
    candidateId: randomUUID(),
    title: memory.title,
    summary: memory.summary,
    body: memory.body,
    candidateTime: latestTime,
    sourceFastIds,
  }))
}

/** 校验分组结果是全部输入候选的完整分区（不重不漏、无额外 ID）。 */
function assertCompletePartition(
  groups: readonly { candidateIds: readonly string[] }[],
  inputIds: ReadonlySet<string>,
): void {
  const seen = new Set<string>()
  for (const group of groups) {
    for (const id of group.candidateIds) {
      if (!inputIds.has(id)) {
        throw new DailyMemoryError("invalid-input", `分组包含本批之外的 candidateId '${id}'`)
      }
      if (seen.has(id)) {
        throw new DailyMemoryError("invalid-input", `candidateId '${id}' 出现在多个分组`)
      }
      seen.add(id)
    }
  }
  if (seen.size !== inputIds.size) {
    throw new DailyMemoryError("invalid-input", "分组结果不是全部候选的完整分区（有候选缺失）")
  }
}

/** 从 LLM 返回中拼接文本块。 */
function extractText(result: { readonly content: readonly { type: string; text?: string }[] }): string {
  let text = ""
  for (const block of result.content) {
    if (block.type === "text" && block.text !== undefined) {
      text += block.text
    }
  }
  return text
}
