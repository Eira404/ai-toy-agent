/* global structuredClone */
import assert from "node:assert/strict"
import test from "node:test"
import { Context, Service } from "cordis"
import { EmbeddingRuntime } from "toy-embedding"
import { MemoryRead } from "../lib/index.js"

const SCOPE = { userId: "u1", memorySpaceId: "space1" }

const FAST_OK = { titleSucceeded: true, vectorSucceeded: true, hits: [{ record: { fastId: "f1" }, matchedBy: ["VECTOR"], vectorScore: 0.9 }] }
const LONG_OK = { status: "COMPLETE", blocks: [{ blockId: "b1", domain: "person", title: "小明", aliases: [], summary: "s", overviewBody: "o", reason: "BLOCK_VECTOR", score: 0.8, details: [] }] }

function makeEmbedding(fail = false) {
  return {
    providerInfo: (id) => ({ id, name: "fake" }),
    embed: async (request) => {
      if (fail) {
        throw new Error("embedding failed")
      }
      return {
        vectors: request.texts.map(() => [0.1, 0.2, 0.3]),
        modelId: "fake-model",
        dimensions: 3,
      }
    },
  }
}

class FakeFast extends Service {
  constructor(ctx, config) {
    super(ctx, "memoryFast")
    this.impl = config.impl ?? (async () => FAST_OK)
  }

  search(input) {
    return this.impl(input)
  }
}

class FakeLong extends Service {
  constructor(ctx, config) {
    super(ctx, "memoryLong")
    this.weak = config.weak ?? (async () => LONG_OK)
    this.strong = config.strong ?? (async () => LONG_OK)
  }

  searchWeak(input) {
    return this.weak(input)
  }

  searchStrong(input) {
    return this.strong(input)
  }
}

async function setup(overrides = {}) {
  const ctx = new Context()
  const fibers = []
  fibers.push(await ctx.plugin(EmbeddingRuntime))
  const unregister = ctx.embedding.registerAdapter("fake", makeEmbedding(overrides.embeddingFail))
  fibers.push(await ctx.plugin(FakeFast, { impl: overrides.fastImpl }))
  fibers.push(await ctx.plugin(FakeLong, { weak: overrides.weakImpl, strong: overrides.strongImpl }))
  fibers.push(
    await ctx.plugin(MemoryRead, {
      embeddingProvider: "fake",
      embeddingModel: "fake-model",
      now: () => 0,
      ...overrides.config,
    }),
  )
  return {
    ctx,
    memoryRead: ctx.memoryRead,
    async dispose() {
      unregister()
      for (const fiber of fibers.reverse()) {
        await fiber.dispose()
      }
    },
  }
}

test("完整检索：Embedding 成功，Fast/Long 双路成功 → COMPLETE", async () => {
  const app = await setup()
  try {
    const result = await app.memoryRead.search({ scope: SCOPE, query: "小明", mode: "weak" })
    assert.equal(result.status, "COMPLETE")
    assert.equal(result.fast.hits.length, 1)
    assert.equal(result.long.blocks.length, 1)
  } finally {
    await app.dispose()
  }
})

test("Embedding 失败降级：queryVector 传 null，title 命中 → PARTIAL", async () => {
  let receivedQueryVector = "unset"
  const app = await setup({
    embeddingFail: true,
    fastImpl: async (input) => {
      receivedQueryVector = input.queryVector
      return { titleSucceeded: true, vectorSucceeded: false, hits: [{ record: { fastId: "f1" }, matchedBy: ["TITLE"], vectorScore: null }] }
    },
  })
  try {
    const result = await app.memoryRead.search({ scope: SCOPE, query: "小明", mode: "weak" })
    assert.equal(receivedQueryVector, null)
    assert.equal(result.status, "PARTIAL")
    assert.equal(result.fast.hits.length, 1)
  } finally {
    await app.dispose()
  }
})

test("分支失败隔离：Fast 耗尽降级占位，Long 正常 → PARTIAL", async () => {
  const app = await setup({
    fastImpl: async () => {
      throw new Error("fast boom")
    },
  })
  try {
    const result = await app.memoryRead.search({ scope: SCOPE, query: "小明", mode: "weak" })
    assert.equal(result.fast.titleSucceeded, false)
    assert.equal(result.fast.vectorSucceeded, false)
    assert.equal(result.fast.hits.length, 0)
    assert.equal(result.long.blocks.length, 1)
    assert.equal(result.status, "PARTIAL")
  } finally {
    await app.dispose()
  }
})

test("重试：Fast 第一次失败、第二次成功 → 最终成功", async () => {
  let calls = 0
  const app = await setup({
    fastImpl: async () => {
      calls += 1
      if (calls === 1) {
        throw new Error("transient")
      }
      return FAST_OK
    },
  })
  try {
    const result = await app.memoryRead.search({ scope: SCOPE, query: "小明", mode: "weak" })
    assert.equal(calls, 2)
    assert.equal(result.status, "COMPLETE")
  } finally {
    await app.dispose()
  }
})

test("mode 透传：strong 调用 searchStrong，weak 调用 searchWeak", async () => {
  let weakCalls = 0
  let strongCalls = 0
  const app = await setup({
    weakImpl: async () => {
      weakCalls += 1
      return LONG_OK
    },
    strongImpl: async () => {
      strongCalls += 1
      return LONG_OK
    },
  })
  try {
    await app.memoryRead.search({ scope: SCOPE, query: "小明", mode: "strong" })
    await app.memoryRead.search({ scope: SCOPE, query: "小明", mode: "weak" })
    assert.equal(strongCalls, 1)
    assert.equal(weakCalls, 1)
  } finally {
    await app.dispose()
  }
})

test("全失败：Embedding 失败且两路无结果 → UNAVAILABLE", async () => {
  const app = await setup({
    embeddingFail: true,
    fastImpl: async () => ({ titleSucceeded: false, vectorSucceeded: false, hits: [] }),
    weakImpl: async () => ({ status: "UNAVAILABLE", blocks: [] }),
  })
  try {
    const result = await app.memoryRead.search({ scope: SCOPE, query: "小明", mode: "weak" })
    assert.equal(result.status, "UNAVAILABLE")
  } finally {
    await app.dispose()
  }
})
