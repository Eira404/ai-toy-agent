/* global structuredClone */
import assert from "node:assert/strict"
import test from "node:test"
import { Context } from "cordis"
import { ToyStorage } from "toy-storage"
import { EmbeddingRuntime } from "toy-embedding"
import { FastMemory, fastRelationalSchema, defineFastVectorSchema } from "../lib/index.js"
import { DIM, FakeRelational, FakeVector, fakeEmbeddingAdapter, fakeVector } from "./helpers.mjs"

const NOW = "2026-11-09T00:00:00.000Z"
const SCOPE = { userId: "u1", memorySpaceId: "space1" }
const DRAFT = { title: "咖啡偏好", summary: "用户平时喝不加糖的冰美式", body: "- 用户平时喝不加糖的冰美式。" }

async function setup(overrides = {}) {
  const ctx = new Context()
  const fibers = []
  fibers.push(await ctx.plugin(ToyStorage))
  fibers.push(await ctx.plugin(EmbeddingRuntime))
  fibers.push(await ctx.plugin(FakeRelational, { schema: fastRelationalSchema }))
  fibers.push(await ctx.plugin(FakeVector, { schema: defineFastVectorSchema(DIM) }))
  const unregister = ctx.embedding.registerAdapter("fake", fakeEmbeddingAdapter)
  fibers.push(
    await ctx.plugin(FastMemory, {
      embeddingProvider: "fake",
      embeddingModel: "fake-model",
      now: () => NOW,
      autoIndex: false,
      ...overrides,
    }),
  )
  return {
    ctx,
    memoryFast: ctx.memoryFast,
    relational: ctx.storage.get("relational", "main"),
    vector: ctx.storage.get("vector", "main"),
    async dispose() {
      unregister()
      for (const fiber of fibers.reverse()) {
        await fiber.dispose()
      }
    },
  }
}

test("append 写入记录与待办，titleKey 由程序规范化", async () => {
  const app = await setup()
  try {
    const result = await app.memoryFast.append({
      scope: SCOPE,
      sessionId: "s1",
      turnId: "t1",
      drafts: [{ ...DRAFT, title: "  咖啡偏好 " }],
    })
    assert.equal(result.records.length, 1)
    const record = result.records[0]
    assert.equal(record.title, "  咖啡偏好 ")
    assert.equal(record.titleKey, "咖啡偏好")
    assert.equal(record.consumedBatchId, null)
    assert.equal(record.createdAt, NOW)
    // 主记录与待办各写一行
    assert.equal(app.relational.rows.get("toy_memory_fast_records").size, 1)
    const jobs = app.relational.rows.get("toy_memory_fast_embedding_jobs")
    assert.equal(jobs.size, 1)
    const job = jobs.get(result.writeId)
    assert.equal(job.status, "pending")
    assert.equal(job.attempts, 0)
    assert.equal(job.next_attempt_at, NOW)
  } finally {
    await app.dispose()
  }
})

test("append 并发重试同一 Turn 幂等返回已提交批次", async () => {
  const app = await setup()
  try {
    const input = { scope: SCOPE, sessionId: "s1", turnId: "t1", drafts: [DRAFT] }
    const first = await app.memoryFast.append(input)
    const second = await app.memoryFast.append(input)
    assert.equal(second.writeId, first.writeId)
    assert.deepEqual(second.records.map((record) => record.fastId), first.records.map((record) => record.fastId))
    assert.equal(app.relational.rows.get("toy_memory_fast_records").size, 1)
  } finally {
    await app.dispose()
  }
})

test("search 标题完全匹配优先且不依赖向量", async () => {
  const app = await setup()
  try {
    await app.memoryFast.append({ scope: SCOPE, sessionId: "s1", turnId: "t1", drafts: [DRAFT] })
    const result = await app.memoryFast.search({
      scope: SCOPE,
      query: "  咖啡偏好 ",
      queryVector: null,
    })
    assert.equal(result.titleSucceeded, true)
    assert.equal(result.vectorSucceeded, false)
    assert.equal(result.hits.length, 1)
    assert.deepEqual(result.hits[0].matchedBy, ["TITLE"])
    assert.equal(result.hits[0].vectorScore, null)
    assert.equal(result.hits[0].record.titleKey, "咖啡偏好")
  } finally {
    await app.dispose()
  }
})

test("search 向量路：补写向量后按相似度命中", async () => {
  const app = await setup()
  try {
    await app.memoryFast.append({ scope: SCOPE, sessionId: "s1", turnId: "t1", drafts: [DRAFT] })
    await app.memoryFast.runEmbeddingJobs()
    const result = await app.memoryFast.search({
      scope: SCOPE,
      query: "冰美式",
      queryVector: fakeVector("用户平时喝不加糖的冰美式"),
    })
    assert.equal(result.vectorSucceeded, true)
    assert.equal(result.hits.length, 1)
    assert.deepEqual(result.hits[0].matchedBy, ["VECTOR"])
    assert.ok(result.hits[0].vectorScore >= 0.99)
  } finally {
    await app.dispose()
  }
})

test("search 双通道去重：同一记录两路命中只返回一次并保留两个原因", async () => {
  const app = await setup()
  try {
    await app.memoryFast.append({ scope: SCOPE, sessionId: "s1", turnId: "t1", drafts: [DRAFT] })
    await app.memoryFast.runEmbeddingJobs()
    const result = await app.memoryFast.search({
      scope: SCOPE,
      query: "咖啡偏好",
      queryVector: fakeVector("用户平时喝不加糖的冰美式"),
    })
    assert.equal(result.hits.length, 1)
    assert.deepEqual(result.hits[0].matchedBy, ["TITLE", "VECTOR"])
    assert.ok(result.hits[0].vectorScore >= 0.99)
  } finally {
    await app.dispose()
  }
})

test("listRecentBySession 只返回指定 Session 的最近有效记录", async () => {
  const app = await setup()
  try {
    await app.memoryFast.append({ scope: SCOPE, sessionId: "s1", turnId: "t1", drafts: [DRAFT] })
    await app.memoryFast.append({
      scope: SCOPE,
      sessionId: "s2",
      turnId: "t1",
      drafts: [{ ...DRAFT, title: "项目A", summary: "项目A十一月交付", body: "- 项目A十一月交付。" }],
    })
    const recent = await app.memoryFast.listRecentBySession(SCOPE, "s1", 10)
    assert.equal(recent.length, 1)
    assert.equal(recent[0].sessionId, "s1")
  } finally {
    await app.dispose()
  }
})

test("runEmbeddingJobs 认领待办、写入向量并置 done", async () => {
  const app = await setup()
  try {
    const { writeId } = await app.memoryFast.append({ scope: SCOPE, sessionId: "s1", turnId: "t1", drafts: [DRAFT] })
    const result = await app.memoryFast.runEmbeddingJobs()
    assert.equal(result.claimed, 1)
    assert.equal(result.completed, 1)
    assert.equal(result.failed, 0)
    assert.equal(app.relational.rows.get("toy_memory_fast_embedding_jobs").get(writeId).status, "done")
    assert.equal(app.vector.records.size, 1)
  } finally {
    await app.dispose()
  }
})

test("listPendingForDaily 返回该空间所有未消费记录", async () => {
  const app = await setup()
  try {
    await app.memoryFast.append({ scope: SCOPE, sessionId: "s1", turnId: "t1", drafts: [DRAFT] })
    await app.memoryFast.append({
      scope: SCOPE,
      sessionId: "s2",
      turnId: "t1",
      drafts: [{ ...DRAFT, title: "项目A", summary: "项目A十一月交付", body: "- 项目A十一月交付。" }],
    })
    const pending = await app.memoryFast.listPendingForDaily(SCOPE)
    assert.equal(pending.length, 2)
  } finally {
    await app.dispose()
  }
})

test("prepareConsumption 生成消费计划并拒绝不一致输入", async () => {
  const app = await setup()
  try {
    const { records, writeId } = await app.memoryFast.append({ scope: SCOPE, sessionId: "s1", turnId: "t1", drafts: [DRAFT] })
    const plan = await app.memoryFast.prepareConsumption({
      scope: SCOPE,
      batchId: "batch-1",
      fastIds: [records[0].fastId],
    })
    assert.equal(plan.batchId, "batch-1")
    assert.deepEqual(plan.vectorIdsToDelete, [records[0].fastId])
    assert.deepEqual(plan.writeIdsToCancel, [writeId])

    await assert.rejects(
      app.memoryFast.prepareConsumption({ scope: SCOPE, batchId: "b", fastIds: ["missing"] }),
      { code: "consume-mismatch" },
    )
  } finally {
    await app.dispose()
  }
})

test("listBySpace 按空间倒序分页浏览，游标不重不漏", async () => {
  const app = await setup()
  try {
    for (let i = 1; i <= 3; i += 1) {
      await app.memoryFast.append({
        scope: SCOPE,
        sessionId: `s${i}`,
        turnId: `t${i}`,
        drafts: [{ ...DRAFT, title: `记忆${i}` }],
      })
    }
    const page1 = await app.memoryFast.listBySpace({ scope: SCOPE, limit: 2 })
    assert.equal(page1.items.length, 2)
    assert.ok(page1.nextCursor !== undefined)

    const page2 = await app.memoryFast.listBySpace({ scope: SCOPE, limit: 2, before: page1.nextCursor })
    assert.equal(page2.items.length, 1)
    assert.equal(page2.nextCursor, undefined)

    const ids = [...page1.items, ...page2.items].map((record) => record.fastId)
    assert.equal(new Set(ids).size, 3)
  } finally {
    await app.dispose()
  }
})

test("listBySpace pendingOnly 只返回未消费记录", async () => {
  const app = await setup()
  try {
    await app.memoryFast.append({ scope: SCOPE, sessionId: "s1", turnId: "t1", drafts: [DRAFT] })
    const record = [...app.relational.rows.get("toy_memory_fast_records").values()][0]
    // 模拟 Daily 已消费该记录
    await app.relational.execute({
      type: "update",
      table: "toy_memory_fast_records",
      where: { type: "eq", field: "fast_id", value: record.fast_id },
      patch: { consumed_batch_id: "batch-1", consumed_at: NOW },
    })

    const all = await app.memoryFast.listBySpace({ scope: SCOPE })
    assert.equal(all.items.length, 1)
    assert.equal(all.items[0].consumedBatchId, "batch-1")

    const pending = await app.memoryFast.listBySpace({ scope: SCOPE, pendingOnly: true })
    assert.equal(pending.items.length, 0)
  } finally {
    await app.dispose()
  }
})

test("countBySpace 返回总量、未消费与已消费", async () => {
  const app = await setup()
  try {
    await app.memoryFast.append({ scope: SCOPE, sessionId: "s1", turnId: "t1", drafts: [DRAFT] })
    await app.memoryFast.append({
      scope: SCOPE,
      sessionId: "s2",
      turnId: "t1",
      drafts: [{ ...DRAFT, title: "项目A", summary: "项目A十一月交付", body: "- 项目A十一月交付。" }],
    })
    const record = [...app.relational.rows.get("toy_memory_fast_records").values()][0]
    await app.relational.execute({
      type: "update",
      table: "toy_memory_fast_records",
      where: { type: "eq", field: "fast_id", value: record.fast_id },
      patch: { consumed_batch_id: "batch-1", consumed_at: NOW },
    })

    const count = await app.memoryFast.countBySpace(SCOPE)
    assert.deepEqual(count, { total: 2, pending: 1, consumed: 1 })
  } finally {
    await app.dispose()
  }
})
