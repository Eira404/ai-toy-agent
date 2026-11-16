import assert from "node:assert/strict"
import test from "node:test"
import { Context } from "cordis"
import { FastWrite } from "../lib/index.js"
import { FakeLlm, FakeMemoryFast } from "./helpers.mjs"

const SCOPE = { userId: "u1", memorySpaceId: "space1" }
const INPUT = {
  scope: SCOPE,
  sessionId: "s1",
  turnId: "t1",
  userMessage: "我喜欢喝不加糖的冰美式",
  recentConversation: [
    { role: "assistant", content: "你好" },
    { role: "user", content: "我喜欢喝不加糖的冰美式" },
  ],
}
const DRAFT = { title: "咖啡偏好", summary: "用户喜欢喝不加糖的冰美式", body: "- 用户喜欢喝不加糖的冰美式。" }

async function setup(config = {}, llmResponses = []) {
  const ctx = new Context()
  const fibers = []
  fibers.push(await ctx.plugin(FakeMemoryFast))
  fibers.push(await ctx.plugin(FakeLlm, { responses: llmResponses }))
  fibers.push(await ctx.plugin(FastWrite, { llmProvider: "fake", llmModel: "fake-model", ...config }))
  return {
    ctx,
    memoryWrite: ctx.memoryWrite,
    fast: ctx.memoryFast,
    llm: ctx.llm,
    async dispose() {
      for (const fiber of fibers.reverse()) {
        await fiber.dispose()
      }
    },
  }
}

test("extract written：LLM 返回非空 → 落库 → written", async () => {
  const app = await setup({}, [{ memories: [DRAFT] }])
  try {
    const result = await app.memoryWrite.extract(INPUT)
    assert.equal(result.kind, "written")
    assert.equal(result.records.length, 1)
    assert.equal(result.records[0].title, "咖啡偏好")
    assert.equal(app.fast.appends.length, 1)
    assert.equal(app.llm.calls.length, 1)
    // prompt 里带了系统提示词与三段式输入
    const messages = app.llm.calls[0].messages
    assert.equal(messages[0].role, "system")
    assert.ok(messages[1].content[0].text.includes("我喜欢喝不加糖的冰美式"))
  } finally {
    await app.dispose()
  }
})

test("extract written：LLM 返回空 → empty，不调用 append", async () => {
  const app = await setup({}, [{ memories: [] }])
  try {
    const result = await app.memoryWrite.extract(INPUT)
    assert.equal(result.kind, "empty")
    assert.equal(app.fast.appends.length, 0)
  } finally {
    await app.dispose()
  }
})

test("extract：首次失败重试一次成功 → written, attempts=2", async () => {
  const app = await setup({}, [new Error("LLM 超时"), { memories: [DRAFT] }])
  try {
    const result = await app.memoryWrite.extract(INPUT)
    assert.equal(result.kind, "written")
    assert.equal(result.attempts, 2)
    assert.equal(app.llm.calls.length, 2)
  } finally {
    await app.dispose()
  }
})

test("extract：重试耗尽 → failed, attempts=2", async () => {
  const app = await setup({}, [new Error("第一次失败"), new Error("第二次失败")])
  try {
    const result = await app.memoryWrite.extract(INPUT)
    assert.equal(result.kind, "failed")
    assert.equal(result.attempts, 2)
    assert.equal(app.fast.appends.length, 0)
  } finally {
    await app.dispose()
  }
})

test("extract：body 不是无序列表 → 校验失败 → 重试成功", async () => {
  const badBody = { ...DRAFT, body: "不是列表的一行" }
  const app = await setup({}, [{ memories: [badBody] }, { memories: [DRAFT] }])
  try {
    const result = await app.memoryWrite.extract(INPUT)
    assert.equal(result.kind, "written")
    assert.equal(result.attempts, 2)
  } finally {
    await app.dispose()
  }
})

test("extract started：立即返回 started，后台继续落库", async () => {
  const app = await setup({}, [{ memories: [DRAFT] }])
  try {
    const result = await app.memoryWrite.extract(INPUT, "started")
    assert.equal(result.kind, "started")
    // 等待后台流水线完成
    await new Promise((resolve) => setTimeout(resolve, 10))
    assert.equal(app.fast.appends.length, 1)
  } finally {
    await app.dispose()
  }
})

test("write：直接落库 title/summary/body", async () => {
  const app = await setup()
  try {
    const result = await app.memoryWrite.write({
      scope: SCOPE,
      sessionId: "s1",
      turnId: "t1",
      drafts: [DRAFT],
    })
    assert.equal(result.kind, "written")
    assert.equal(result.records.length, 1)
    assert.equal(app.fast.appends.length, 1)
    assert.equal(app.llm.calls.length, 0)
  } finally {
    await app.dispose()
  }
})
