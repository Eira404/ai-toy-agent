import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { appendLine } from "../store.mjs"
import { extractKey, loadExtractDone, loadJudgedQuestionIds } from "../resume.mjs"

test("loadExtractDone 只取当前 runId 且 status=done", async () => {
  const dir = await mkdtemp(join(tmpdir(), "eval-resume-"))
  const file = join(dir, "extract_progress.jsonl")
  try {
    await appendLine(file, { runId: "r1", spaceKey: "s", sessionId: "a", turnId: "t1", status: "done" })
    await appendLine(file, { runId: "r1", spaceKey: "s", sessionId: "a", turnId: "t2", status: "error" })
    await appendLine(file, { runId: "r2", spaceKey: "s", sessionId: "a", turnId: "t1", status: "done" })
    const done = loadExtractDone(file, "r1")
    assert.equal(done.size, 1)
    assert.ok(done.has(extractKey("s", "a", "t1")))
    assert.ok(!done.has(extractKey("s", "a", "t2")))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("loadJudgedQuestionIds 只取当前 runId 的 questionId", async () => {
  const dir = await mkdtemp(join(tmpdir(), "eval-resume-"))
  const file = join(dir, "results.jsonl")
  try {
    await appendLine(file, { runId: "r1", questionId: "q1", judge: { correct: true } })
    await appendLine(file, { runId: "r1", questionId: "q2", judge: { correct: false } })
    await appendLine(file, { runId: "r9", questionId: "q3", judge: { correct: true } })
    const judged = loadJudgedQuestionIds(file, "r1")
    assert.deepEqual([...judged].sort(), ["q1", "q2"])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("extractKey 稳定且可区分", () => {
  assert.equal(extractKey("s", "a", "t1"), extractKey("s", "a", "t1"))
  assert.notEqual(extractKey("s", "a", "t1"), extractKey("s", "a", "t2"))
})
