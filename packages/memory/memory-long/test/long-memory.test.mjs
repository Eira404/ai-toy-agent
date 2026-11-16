/* global structuredClone */
import assert from "node:assert/strict"
import test from "node:test"
import { Context } from "cordis"
import { ToyStorage } from "toy-storage"
import {
  LongMemory,
  longRelationalSchema,
  defineLongVectorSchema,
} from "../lib/index.js"
import { DIM, FakeRelational, FakeVector, fakeVector } from "./helpers.mjs"

const NOW = "2026-11-09T00:00:00.000Z"
const SCOPE = { userId: "u1", memorySpaceId: "space1" }
const VALUE = { version: "v1", state: { value: 0.8 } }

const BLOCK = {
  content: {
    domain: "person",
    title: "小明",
    aliases: ["明哥"],
    summary: "用户关于初中同学小明的记忆",
    overviewBody: "小明是用户的初中同学，目前在上海工作。",
    lifecycleStatus: "active",
  },
  summaryVector: fakeVector("用户关于初中同学小明的记忆"),
  value: VALUE,
  details: [
    {
      kind: "CREATE",
      summary: "用户与小明去上海的信息",
      summaryVector: fakeVector("用户与小明去上海的信息"),
      body: "用户与小明于 2026 年 7 月一起去了上海 BW。",
      lifecycleStatus: "active",
      value: VALUE,
    },
  ],
}

async function setup(overrides = {}) {
  const ctx = new Context()
  const fibers = []
  fibers.push(await ctx.plugin(ToyStorage))
  fibers.push(await ctx.plugin(FakeRelational, { schema: longRelationalSchema }))
  fibers.push(await ctx.plugin(FakeVector, { schema: defineLongVectorSchema(DIM) }))
  fibers.push(await ctx.plugin(LongMemory, { now: () => NOW, ...overrides }))
  return {
    ctx,
    memoryLong: ctx.memoryLong,
    relational: ctx.storage.get("relational", "main"),
    vector: ctx.storage.get("vector", "main"),
    async dispose() {
      for (const fiber of fibers.reverse()) {
        await fiber.dispose()
      }
    },
  }
}

async function createBlock(app, scope = SCOPE) {
  const result = await app.memoryLong.applyChanges(scope, { changes: [{ kind: "CREATE", ...BLOCK }] })
  return result.blockIds[0]
}

test("applyChanges 创建块与细节，getBlock 读回完整结构", async () => {
  const app = await setup()
  try {
    const blockId = await createBlock(app)
    const block = await app.memoryLong.getBlock(SCOPE, blockId)
    assert.ok(block)
    assert.equal(block.blockId, blockId)
    assert.equal(block.domain, "person")
    assert.deepEqual(block.aliases, ["明哥"])
    assert.equal(block.overviewBody, "小明是用户的初中同学，目前在上海工作。")
    assert.equal(block.lifecycleStatus, "active")
    assert.equal(block.value.version, "v1")
    assert.deepEqual(block.details.map((d) => d.summary), ["用户与小明去上海的信息"])
    assert.equal(block.createdAt, NOW)
  } finally {
    await app.dispose()
  }
})

test("searchWeak title 完全匹配不依赖向量", async () => {
  const app = await setup()
  try {
    await createBlock(app)
    const result = await app.memoryLong.searchWeak({
      scope: SCOPE,
      query: "  小明 ",
      queryVector: null,
    })
    assert.equal(result.status, "COMPLETE")
    assert.equal(result.blocks.length, 1)
    assert.equal(result.blocks[0].reason, "TITLE_MATCH")
    assert.equal(result.blocks[0].score, null)
    assert.equal(result.blocks[0].details.length, 0)
  } finally {
    await app.dispose()
  }
})

test("searchWeak alias 完全匹配命中块", async () => {
  const app = await setup()
  try {
    await createBlock(app)
    const result = await app.memoryLong.searchWeak({
      scope: SCOPE,
      query: "明哥",
      queryVector: null,
    })
    assert.equal(result.blocks.length, 1)
    assert.equal(result.blocks[0].reason, "TITLE_MATCH")
  } finally {
    await app.dispose()
  }
})

test("searchWeak 向量命中块并在块内命中细节", async () => {
  const app = await setup()
  try {
    await createBlock(app)
    const result = await app.memoryLong.searchWeak({
      scope: SCOPE,
      query: "上海",
      queryVector: fakeVector("用户与小明去上海的信息"),
    })
    assert.equal(result.status, "COMPLETE")
    assert.equal(result.blocks.length, 1)
    const hit = result.blocks[0]
    assert.equal(hit.reason, "BLOCK_VECTOR")
    assert.ok(hit.details.length >= 1)
    assert.equal(hit.details[0].summary, "用户与小明去上海的信息")
  } finally {
    await app.dispose()
  }
})

test("searchStrong 平级检索：细节命中时带回父块 PARENT_CONTEXT", async () => {
  const app = await setup({ strongMinResults: 1, strongVectorThreshold: 0.5 })
  try {
    // 人工正交向量：query 只命中细节 summary，块 summary 因正交而不命中。
    await app.memoryLong.applyChanges(SCOPE, {
      changes: [
        {
          kind: "CREATE",
          content: {
            domain: "person",
            title: "小明",
            aliases: [],
            summary: "用户关于初中同学小明的记忆",
            overviewBody: "小明是用户的初中同学。",
            lifecycleStatus: "active",
          },
          summaryVector: [1, 0, 0, 0],
          value: VALUE,
          details: [
            {
              kind: "CREATE",
              summary: "用户与小明去上海的信息",
              summaryVector: [0, 1, 0, 0],
              body: "用户与小明于 2026 年 7 月一起去了上海 BW。",
              lifecycleStatus: "active",
              value: VALUE,
            },
          ],
        },
      ],
    })
    const result = await app.memoryLong.searchStrong({
      scope: SCOPE,
      query: "上海 BW",
      queryVector: [0, 1, 0, 0],
    })
    assert.equal(result.blocks.length, 1)
    const hit = result.blocks[0]
    assert.equal(hit.reason, "PARENT_CONTEXT")
    assert.equal(hit.details[0].body, "用户与小明于 2026 年 7 月一起去了上海 BW。")
  } finally {
    await app.dispose()
  }
})

test("applyChanges UPDATE 携带不一致的 old 信息时抛 conflict", async () => {
  const app = await setup()
  try {
    const blockId = await createBlock(app)
    await assert.rejects(
      app.memoryLong.applyChanges(SCOPE, {
        changes: [
          {
            kind: "UPDATE",
            blockId,
            oldContent: { ...BLOCK.content, title: "错误标题" },
            oldValue: VALUE,
            content: { ...BLOCK.content, title: "小明（初中同学）" },
            summaryVector: BLOCK.summaryVector,
            value: VALUE,
            details: [],
          },
        ],
      }),
      { code: "conflict" },
    )
  } finally {
    await app.dispose()
  }
})

test("applyChanges UPDATE 变更标题、别名与正文", async () => {
  const app = await setup()
  try {
    const blockId = await createBlock(app)
    await app.memoryLong.applyChanges(SCOPE, {
      changes: [
        {
          kind: "UPDATE",
          blockId,
          oldContent: BLOCK.content,
          oldValue: VALUE,
          content: {
            ...BLOCK.content,
            title: "小明（初中同学）",
            aliases: ["明哥", "小明明"],
            overviewBody: "小明是用户的初中同学，目前在上海工作，喜欢吃苹果。",
          },
          summaryVector: fakeVector("用户关于初中同学小明的记忆"),
          value: { version: "v1", state: { value: 0.9 } },
          details: [],
        },
      ],
    })
    const block = await app.memoryLong.getBlock(SCOPE, blockId)
    assert.equal(block.title, "小明（初中同学）")
    assert.deepEqual([...block.aliases].sort(), ["明哥", "小明明"].sort())
    assert.equal(block.overviewBody, "小明是用户的初中同学，目前在上海工作，喜欢吃苹果。")
  } finally {
    await app.dispose()
  }
})

test("applyChanges ARCHIVE 块后检索不返回，但 getBlock 仍可读", async () => {
  const app = await setup()
  try {
    const blockId = await createBlock(app)
    await app.memoryLong.applyChanges(SCOPE, {
      changes: [{ kind: "ARCHIVE", blockId, oldValue: VALUE }],
    })
    const result = await app.memoryLong.searchWeak({
      scope: SCOPE,
      query: "小明",
      queryVector: fakeVector("用户关于初中同学小明的记忆"),
    })
    assert.equal(result.blocks.length, 0)
    const block = await app.memoryLong.getBlock(SCOPE, blockId)
    assert.equal(block.lifecycleStatus, "archived")
    assert.equal(block.details[0].lifecycleStatus, "archived")
  } finally {
    await app.dispose()
  }
})

test("freezeSnapshot 返回全部有效块含细节", async () => {
  const app = await setup()
  try {
    await createBlock(app)
    const blocks = await app.memoryLong.freezeSnapshot(SCOPE)
    assert.equal(blocks.length, 1)
    assert.equal(blocks[0].details.length, 1)
  } finally {
    await app.dispose()
  }
})

test("listBlocksByDomain 与 recallBySummary 按 Domain 召回", async () => {
  const app = await setup()
  try {
    await createBlock(app)
    const summaries = await app.memoryLong.listBlocksByDomain(SCOPE, "person")
    assert.equal(summaries.length, 1)
    assert.equal(summaries[0].title, "小明")

    const recalled = await app.memoryLong.recallBySummary(
      SCOPE,
      "person",
      fakeVector("用户关于初中同学小明的记忆"),
      5,
    )
    assert.equal(recalled.length, 1)
    assert.ok(recalled[0].score > 0.9)
  } finally {
    await app.dispose()
  }
})

test("跨空间隔离：不同 memorySpaceId 互不可见", async () => {
  const app = await setup()
  try {
    await createBlock(app)
    const other = { userId: "u1", memorySpaceId: "space2" }
    const result = await app.memoryLong.searchWeak({ scope: other, query: "小明", queryVector: null })
    assert.equal(result.blocks.length, 0)
    const list = await app.memoryLong.listBlocksByDomain(other, "person")
    assert.equal(list.length, 0)
  } finally {
    await app.dispose()
  }
})

test("listBySpace 分页返回摘要与游标，支持 orderBy 与过滤", async () => {
  const app = await setup()
  try {
    await createBlock(app)
    await createBlock(app)
    const page = await app.memoryLong.listBySpace({ scope: SCOPE, limit: 1 })
    assert.equal(page.items.length, 1)
    assert.ok(page.nextCursor)
    const next = await app.memoryLong.listBySpace({ scope: SCOPE, limit: 1, before: page.nextCursor })
    assert.equal(next.items.length, 1)

    // orderBy createdAt 也可翻页
    const byCreated = await app.memoryLong.listBySpace({ scope: SCOPE, orderBy: "createdAt" })
    assert.equal(byCreated.items.length, 2)

    // lifecycle 过滤：默认含归档，archived 过滤返回空
    const active = await app.memoryLong.listBySpace({ scope: SCOPE, lifecycle: "active" })
    assert.equal(active.items.length, 2)
  } finally {
    await app.dispose()
  }
})

test("countBlocks 与 countBlocksByDomain 统计块数量", async () => {
  const app = await setup()
  try {
    await createBlock(app)
    await createBlock(app)
    const total = await app.memoryLong.countBlocks(SCOPE)
    assert.equal(total, 2)
    const byDomain = await app.memoryLong.countBlocksByDomain(SCOPE)
    assert.equal(Object.keys(byDomain).length, 6)
    assert.equal(byDomain.person, 2)
    assert.equal(byDomain.self, 0)
    assert.equal(byDomain.project, 0)
  } finally {
    await app.dispose()
  }
})

test("applyChanges 校验非法 domain 与超长 title", async () => {
  const app = await setup()
  try {
    await assert.rejects(
      app.memoryLong.applyChanges(SCOPE, {
        changes: [{ kind: "CREATE", ...BLOCK, content: { ...BLOCK.content, domain: "invalid" } }],
      }),
      { code: "invalid-input" },
    )
    await assert.rejects(
      app.memoryLong.applyChanges(SCOPE, {
        changes: [
          { kind: "CREATE", ...BLOCK, content: { ...BLOCK.content, title: "长".repeat(41) } },
        ],
      }),
      { code: "invalid-input" },
    )
  } finally {
    await app.dispose()
  }
})

test("applyChanges UPDATE 不存在的细节抛 detail-not-found", async () => {
  const app = await setup()
  try {
    const blockId = await createBlock(app)
    await assert.rejects(
      app.memoryLong.applyChanges(SCOPE, {
        changes: [
          {
            kind: "UPDATE",
            blockId,
            oldContent: BLOCK.content,
            oldValue: VALUE,
            content: BLOCK.content,
            summaryVector: BLOCK.summaryVector,
            value: VALUE,
            details: [{ kind: "ARCHIVE", detailId: "nonexistent", oldValue: VALUE }],
          },
        ],
      }),
      { code: "detail-not-found" },
    )
  } finally {
    await app.dispose()
  }
})

test("向量检索按 userId 隔离", async () => {
  const app = await setup()
  try {
    await createBlock(app)
    const other = { userId: "u2", memorySpaceId: "space1" }
    const result = await app.memoryLong.searchWeak({
      scope: other,
      query: "上海",
      queryVector: fakeVector("用户与小明去上海的信息"),
    })
    assert.equal(result.blocks.length, 0)
  } finally {
    await app.dispose()
  }
})
