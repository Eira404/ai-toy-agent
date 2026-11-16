import type { FastRecord } from "toy-memory-fast"
import { DailyMemoryError } from "../../error.js"
import { mapStage, type StageEnv } from "../../stage.js"
import type { FreezeBaseline } from "../freeze/types.js"
import { buildUserMessage, STAGE_1_SYSTEM_MESSAGE } from "./prompts.js"
import { sessionConsolidationJsonSchema, SessionConsolidationOutputSchema } from "./schema.js"
import type { SessionCandidate } from "./types.js"

/**
 * 阶段一：Session 内 Fast 整理。
 *
 * 把冻结 Fast 按 sessionId 分组、每组按 createdAt 升序，交给 LLM 整合成
 * 一条或多条 title/summary/body 候选，并程序附加 candidateTime（该组最晚
 * createdAt）与 sourceFastIds（该组全部 Fast ID）。
 *
 * 简化版：每个 Session 作为一组直接处理；超容量时的「相似度分组 + 最多两轮
 * 归并」暂未实现（TODO）。
 */
export async function runConsolidateSession(
  env: StageEnv,
  baseline: FreezeBaseline,
): Promise<SessionCandidate[]> {
  const bySession = new Map<string, FastRecord[]>()
  for (const record of baseline.fastRecords) {
    const list = bySession.get(record.sessionId) ?? []
    list.push(record)
    bySession.set(record.sessionId, list)
  }

  const groups = [...bySession.values()]
  const perSession = await mapStage(
    env,
    groups,
    (records) => consolidateSessionGroup(env, records),
    "consolidate-session",
  )
  return perSession.flat()
}

/** 整合单个 Session 的全部 Fast 为候选。 */
async function consolidateSessionGroup(
  env: StageEnv,
  records: FastRecord[],
): Promise<SessionCandidate[]> {
  const sorted = [...records].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  const latestTime = sorted.at(-1)?.createdAt ?? ""
  const memoriesStr = sorted
    .map(
      (record) =>
        `Time:${record.createdAt}\nTitle:${record.title}\nSummary:${record.summary}\nBody:${record.body}`,
    )
    .join("\n---\n")

  const result = await env.ctx.llm.generate({
    provider: env.config.llmProvider,
    model: env.config.llmModel,
    messages: [
      { role: "system", content: [{ type: "text", text: STAGE_1_SYSTEM_MESSAGE }] },
      { role: "user", content: [{ type: "text", text: buildUserMessage(memoriesStr) }] },
    ],
    responseFormat: {
      type: "json_schema",
      name: "session_consolidation",
      schema: sessionConsolidationJsonSchema,
    },
  })

  let text = ""
  for (const block of result.content) {
    if (block.type === "text") {
      text += block.text
    }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new DailyMemoryError("invalid-input", "阶段一 LLM 输出不是合法 JSON", { cause: error })
  }
  const validated = SessionConsolidationOutputSchema.parse(parsed)

  const sourceFastIds = sorted.map((record) => record.fastId)
  return validated.memories.map((memory) => ({
    title: memory.title,
    summary: memory.summary,
    body: memory.body,
    candidateTime: latestTime,
    sourceFastIds,
  }))
}
