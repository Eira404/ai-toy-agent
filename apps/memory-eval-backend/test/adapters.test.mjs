import test from "node:test"
import assert from "node:assert/strict"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { InternalAdapter } from "../adapters/internal.ts"
import { LongMemEvalV1Adapter } from "../adapters/longmemeval_v1.ts"

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixtures = join(__dirname, "fixtures")

test("internal adapter：normalize / buildTurns / metricGroups / judge", async () => {
  const adapter = new InternalAdapter({ dataFile: join(fixtures, "internal-sample.json") })
  await adapter.load()
  const n = adapter.normalize()

  assert.equal(n.mode, "independent")
  assert.equal(n.items.length, 2)
  assert.equal(n.questions.length, 2)
  assert.equal(n.items[0].spaceKey, "int-1")
  assert.equal(n.items[0].questionId, "int-1")

  const turns = adapter.buildTurns(n.items[0])
  assert.equal(turns.length, 2) // s1 有 2 个 user 轮
  assert.equal(turns[0].userMessage, "我最喜欢蓝色。")
  assert.equal(turns[0].recentConversation.length, 0)
  assert.equal(turns[1].userMessage, "尤其是深蓝。")
  assert.equal(turns[1].recentConversation.length, 2)

  const groups = adapter.metricGroups()
  assert.equal(groups.length, 5)
  assert.ok(groups.includes("factual"))
  assert.ok(groups.includes("abstention"))

  const prompt = adapter.judge(n.questions[1], "不知道", "无法确定")
  assert.ok(prompt.system.includes("无法确定"))
  assert.ok(prompt.user.includes("无法确定"))
})

test("longmemeval adapter：normalize(independent) / buildTurns / metricGroups / judge abstention", async () => {
  const adapter = new LongMemEvalV1Adapter({ dataFile: join(fixtures, "longmemeval-sample.json") })
  await adapter.load()
  const n = adapter.normalize()

  assert.equal(n.mode, "independent")
  assert.equal(n.items.length, 2) // 每题一个 item
  assert.equal(n.questions.length, 2)
  assert.equal(n.items[0].questionId, "lm-001")
  assert.equal(n.items[0].spaceKey, "lm-001")
  assert.equal(n.items[0].history.length, 1) // 该题自己的 1 个 session
  assert.equal(n.items[1].questionId, "lm-002_abs")

  const turns = adapter.buildTurns(n.items[0])
  assert.equal(turns.length, 1) // lm-001 的 session 只有 1 个 user 轮
  assert.equal(turns[0].sessionId, "lm-001:s1")

  assert.deepEqual(adapter.metricGroups(), ["single-session-user", "abstention"])

  const absQuestion = n.questions.find((q) => q.questionId.endsWith("_abs"))
  const normalQuestion = n.questions.find((q) => !q.questionId.endsWith("_abs"))
  assert.ok(absQuestion)
  assert.ok(normalQuestion)

  const absPrompt = adapter.judge(absQuestion, "The user has 2 cats.", absQuestion.gold)
  assert.ok(absPrompt.system.includes("信息不完整"))
  const normalPrompt = adapter.judge(normalQuestion, "blue", normalQuestion.gold)
  assert.ok(normalPrompt.system.includes("包含正确答案"))
})
