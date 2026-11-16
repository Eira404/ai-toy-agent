/* global console */
import { Context, Service } from "cordis"
import { EmbeddingRuntime } from "toy-embedding"
import { MemoryRead } from "toy-memory-read"

// 内存 mock：Embedding 路由、Fast 与 Long 服务，便于单独演示 read 的编排。
const fakeEmbeddingAdapter = {
  providerInfo: (id) => ({ id, name: "fake" }),
  embed: async (request) => ({
    vectors: request.texts.map(() => [0.1, 0.2, 0.3]),
    modelId: "fake-model",
    dimensions: 3,
  }),
}

class FakeFast extends Service {
  constructor(ctx) {
    super(ctx, "memoryFast")
  }

  async search() {
    return {
      titleSucceeded: true,
      vectorSucceeded: true,
      hits: [
        { record: { fastId: "f1", title: "咖啡偏好", summary: "用户喝冰美式", body: "- 用户喝冰美式。" }, matchedBy: ["VECTOR"], vectorScore: 0.9 },
      ],
    }
  }
}

class FakeLong extends Service {
  constructor(ctx) {
    super(ctx, "memoryLong")
  }

  async searchWeak() {
    return {
      status: "COMPLETE",
      blocks: [
        { blockId: "b1", domain: "person", title: "小明", aliases: ["明哥"], summary: "初中同学", overviewBody: "小明是初中同学。", reason: "TITLE_MATCH", score: null, details: [] },
      ],
    }
  }

  async searchStrong() {
    return {
      status: "COMPLETE",
      blocks: [
        { blockId: "b2", domain: "event", title: "上海旅行", aliases: [], summary: "上海 BW", overviewBody: "用户与小明去了上海 BW。", reason: "BLOCK_VECTOR", score: 0.8, details: [{ detailId: "d1", summary: "行程", body: "2026 年 7 月去了上海 BW。", score: 0.85 }] },
      ],
    }
  }
}

const ctx = new Context()
const fibers = []
fibers.push(await ctx.plugin(EmbeddingRuntime))
const unregister = ctx.embedding.registerAdapter("fake", fakeEmbeddingAdapter)
fibers.push(await ctx.plugin(FakeFast))
fibers.push(await ctx.plugin(FakeLong))
fibers.push(
  await ctx.plugin(MemoryRead, {
    embeddingProvider: "fake",
    embeddingModel: "fake-model",
  }),
)

const scope = { userId: "u1", memorySpaceId: "space1" }

try {
  const weak = await ctx.memoryRead.search({ scope, query: "小明", mode: "weak" })
  console.log("弱检索:", weak.status, "Fast", weak.fast.hits.length, "Long", weak.long.blocks.length)

  const strong = await ctx.memoryRead.search({ scope, query: "上海旅行", mode: "strong" })
  console.log("强检索:", strong.status, "Long 块", strong.long.blocks.map((b) => `${b.title}[${b.reason}]`).join(", "))
} finally {
  unregister()
  for (const fiber of fibers.reverse()) {
    await fiber.dispose()
  }
}
