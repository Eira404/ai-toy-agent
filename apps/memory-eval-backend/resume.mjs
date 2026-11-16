/**
 * 断点恢复语义（对齐 REQUIREMENTS.md §6）。
 *
 * - extract：跳过 `status === "done"` 的 `(spaceKey, sessionId, turnId)`。
 * - query/judge：跳过 `results.jsonl` 中已出现的 `questionId`。
 * - daily：崩溃则重跑一次（不做阶段级 resume），由 runner 调用 `runDaily` 幂等完成。
 *
 * 两个加载器都按 `runId` 过滤，避免同一目录里残留旧 run 的行污染本次恢复。
 */
import { readLines } from "./store.mjs"

const SEP = "\u0000"

/** 生成 extract 单位的稳定定位键。 */
export function extractKey(spaceKey, sessionId, turnId) {
  return `${spaceKey}${SEP}${sessionId}${SEP}${turnId}`
}

/**
 * 读取 extract_progress.jsonl，返回已完成的 `(spaceKey, sessionId, turnId)` 键集合。
 *
 * @param {string} extractPath extract_progress.jsonl 路径。
 * @param {string} runId 当前运行 ID（过滤旧 run 的行）。
 * @returns {Set<string>}
 */
export function loadExtractDone(extractPath, runId) {
  const done = new Set()
  for (const line of readLines(extractPath)) {
    if (line && line.runId === runId && line.status === "done") {
      done.add(extractKey(line.spaceKey, line.sessionId, line.turnId))
    }
  }
  return done
}

/**
 * 读取 results.jsonl，返回已判分的 questionId 集合。
 *
 * @param {string} resultsPath results.jsonl 路径。
 * @param {string} runId 当前运行 ID（过滤旧 run 的行）。
 * @returns {Set<string>}
 */
export function loadJudgedQuestionIds(resultsPath, runId) {
  const judged = new Set()
  for (const line of readLines(resultsPath)) {
    if (line && line.runId === runId && typeof line.questionId === "string") {
      judged.add(line.questionId)
    }
  }
  return judged
}
