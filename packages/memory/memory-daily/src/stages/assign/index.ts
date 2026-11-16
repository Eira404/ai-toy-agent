import type { LongBlock, LongBlockSummary, LongDomain } from "toy-memory-long"
import { DailyMemoryError } from "../../error.js"
import { extractText } from "../../llm.js"
import { mapStage, type StageEnv } from "../../stage.js"
import type { LongCandidate } from "../consolidate-cross/types.js"
import { DOMAIN_CRITERIA, LONG_DOMAINS } from "./domain.js"
import { buildTargetUserMessage, STAGE_3_TARGET_SYSTEM_MESSAGE } from "./prompts.js"
import { targetDecisionJsonSchema, TargetDecisionSchema, type TargetDecision } from "./schema.js"
import type { CandidateAssignment } from "./types.js"

/** 相关块筛选的 JEV choice 判据。 */
const RELATED_DECISIONS: Record<string, string> = {
  POSSIBLY_RELATED: "无法排除与候选属于同一对象或维护主题",
  NOT_RELATED: "可以确认不属于同一对象或维护主题",
}

/**
 * 阶段三：Long 候选归属。
 *
 * 对每条候选：JEV 判唯一 Domain → 三路召回该 Domain 的已有块（title/alias 匹配 +
 * summary 向量 + 随机）→ JEV 逐块筛 POSSIBLY_RELATED → LLM 定唯一目标
 * （UPDATE_EXISTING / CREATE_NEW）。
 *
 * 简化版：随机召回用 Math.random（种子不持久化）、title 召回只做完全匹配
 * （不含双向包含）、同批新建目标对齐（12.5.5）未实现。
 */
export async function runAssign(
  env: StageEnv,
  longCandidates: readonly LongCandidate[],
): Promise<CandidateAssignment[]> {
  return mapStage(env, longCandidates, (candidate) => assignCandidate(env, candidate), "assign")
}

async function assignCandidate(env: StageEnv, candidate: LongCandidate): Promise<CandidateAssignment> {
  // 1) Domain 判断（JEV）+ summary 向量（Embedding）并行
  const [domain, vector] = await Promise.all([
    judgeDomain(env, candidate),
    embedSummary(env, candidate.summary),
  ])

  // 2) 三路召回候选块
  const recalled = await recallBlocks(env, candidate, domain, vector)

  // 3) JEV 筛相关块
  const related = await filterRelated(env, candidate, recalled)

  // 4) LLM 定目标（无相关块直接新建）
  const target: TargetDecision =
    related.length === 0 ? { kind: "NEW" } : await decideTarget(env, candidate, domain, related)

  return {
    candidateId: candidate.candidateId,
    domain,
    targetKind: target.kind,
    targetBlockId: target.kind === "EXISTING" ? target.blockId : `new-${candidate.candidateId}`,
  }
}

/** 是否启用了 JEV 路由（无 JEV 时降级）。 */
function hasJev(env: StageEnv): boolean {
  return env.config.jevProvider.trim().length > 0
}

/** JEV 判唯一主要 Domain；无 JEV 时降级为 self。 */
async function judgeDomain(env: StageEnv, candidate: LongCandidate): Promise<LongDomain> {
  if (!hasJev(env)) {
    return "self"
  }
  const state = `Title:${candidate.title}\nSummary:${candidate.summary}\nBody:${candidate.body}`
  const response = await env.ctx.jev.invoke(
    state,
    {
      domain: {
        type: "choice",
        instructions: "Choose exactly one primary memory domain.",
        criteria: DOMAIN_CRITERIA,
      },
    },
    { provider: env.config.jevProvider },
  )
  const answer = response.answers.domain
  if (answer?.type !== "choice" || !LONG_DOMAINS.includes(answer.choice as LongDomain)) {
    throw new DailyMemoryError("invalid-input", "JEV 返回了非法 Domain")
  }
  return answer.choice as LongDomain
}

/** 计算候选 summary 的 Embedding。 */
async function embedSummary(env: StageEnv, summary: string): Promise<readonly number[]> {
  const result = await env.ctx.embedding.embed({
    provider: env.config.embeddingProvider,
    model: env.config.embeddingModel,
    texts: [summary],
    operation: "memory-daily-assign",
  })
  const vector = result.vectors[0]
  if (vector === undefined) {
    throw new DailyMemoryError("invalid-input", "Embedding 返回空向量")
  }
  return vector
}

/** 三路召回：title/alias 匹配 + summary 向量 + 随机，按 blockId 去重、截取 ≤42。 */
async function recallBlocks(
  env: StageEnv,
  candidate: LongCandidate,
  domain: LongDomain,
  vector: readonly number[],
): Promise<LongBlockSummary[]> {
  const summaries = await env.long.listBlocksByDomain(env.scope, domain)
  const byId = new Map(summaries.map((summary) => [summary.blockId, summary]))

  const titleHits = summaries.filter((summary) => matchesTitle(candidate.title, summary))
  const vectorHits =
    summaries.length === 0
      ? []
      : (
          await env.long.recallBySummary(env.scope, domain, vector, Math.min(summaries.length, 21))
        )
          .map((hit) => byId.get(hit.blockId))
          .filter((summary): summary is LongBlockSummary => summary !== undefined)
  const randomHits = randomRecall(summaries)

  // 按优先级（title > vector > random）去重
  const merged = new Map<string, LongBlockSummary>()
  for (const summary of [...titleHits, ...vectorHits, ...randomHits]) {
    merged.set(summary.blockId, summary)
  }
  return [...merged.values()].slice(0, 42)
}

/** title/alias 规范化后完全匹配（简化版，不含双向包含）。 */
function matchesTitle(candidateTitle: string, block: LongBlockSummary): boolean {
  const key = normalizeForRecall(candidateTitle)
  if (key === normalizeForRecall(block.title)) {
    return true
  }
  return block.aliases.some((alias) => key === normalizeForRecall(alias))
}

/** 随机召回：无放回抽样 min(N, 42, max(8, ceil(N*4.2%))) 条。 */
function randomRecall(summaries: readonly LongBlockSummary[]): LongBlockSummary[] {
  const count = Math.min(summaries.length, 42, Math.max(8, Math.ceil(summaries.length * 0.042)))
  const sorted = [...summaries].sort((a, b) => a.blockId.localeCompare(b.blockId))
  return sampleRandom(sorted, count)
}

/** JEV 逐块筛相关：保留 POSSIBLY_RELATED 的块。 */
async function filterRelated(
  env: StageEnv,
  candidate: LongCandidate,
  recalled: readonly LongBlockSummary[],
): Promise<LongBlockSummary[]> {
  if (recalled.length === 0) {
    return []
  }
  // 无 JEV 时跳过筛选，直接交给 LLM 定目标。
  if (!hasJev(env)) {
    return [...recalled]
  }
  const state = `候选：\nTitle:${candidate.title}\nSummary:${candidate.summary}\nBody:${candidate.body}`
  const questions: Record<string, { type: "choice"; instructions: string; criteria: Record<string, string> }> = {}
  recalled.forEach((block, index) => {
    questions[`related_block_${index}`] = {
      type: "choice",
      instructions: `候选与块 ${block.blockId}（title: ${block.title}）是否可能属于同一对象或维护主题？`,
      criteria: RELATED_DECISIONS,
    }
  })
  const response = await env.ctx.jev.invoke(state, questions, { provider: env.config.jevProvider })

  const related: LongBlockSummary[] = []
  recalled.forEach((block, index) => {
    const answer = response.answers[`related_block_${index}`]
    if (answer !== undefined && answer.type === "choice" && answer.choice === "POSSIBLY_RELATED") {
      related.push(block)
    }
  })
  return related
}

/** LLM 定唯一目标：读取相关块完整内容，输出 EXISTING(blockId) / NEW。 */
async function decideTarget(
  env: StageEnv,
  candidate: LongCandidate,
  domain: LongDomain,
  relatedSummaries: readonly LongBlockSummary[],
): Promise<TargetDecision> {
  const relatedBlocks: LongBlock[] = []
  for (const summary of relatedSummaries) {
    const block = await env.long.getBlock(env.scope, summary.blockId)
    if (block !== null) {
      relatedBlocks.push(block)
    }
  }

  const result = await env.ctx.llm.generate({
    provider: env.config.llmProvider,
    model: env.config.llmModel,
    messages: [
      { role: "system", content: [{ type: "text", text: STAGE_3_TARGET_SYSTEM_MESSAGE }] },
      { role: "user", content: [{ type: "text", text: buildTargetUserMessage(candidate, domain, relatedBlocks) }] },
    ],
    responseFormat: { type: "json_schema", name: "target_decision", schema: targetDecisionJsonSchema },
  })

  const text = extractText(result)
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new DailyMemoryError("invalid-input", "阶段三目标 LLM 输出不是合法 JSON", { cause: error })
  }
  const decision = TargetDecisionSchema.parse(parsed)
  if (decision.kind === "EXISTING" && !relatedBlocks.some((block) => block.blockId === decision.blockId)) {
    throw new DailyMemoryError("invalid-input", `目标 LLM 选择了不存在的 blockId '${decision.blockId}'`)
  }
  return decision
}

/** 阶段三 title 召回规范化：NFKC + 英文小写 + 移除空白与标点。 */
function normalizeForRecall(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/[\s\p{P}]+/gu, "")
}

function sampleRandom<T>(items: readonly T[], count: number): T[] {
  const arr = [...items]
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1))
    const tmp = arr[i]!
    arr[i] = arr[j]!
    arr[j] = tmp
  }
  return arr.slice(0, count)
}
