/* global console */
import { Context } from "cordis"
import { ToyStorage } from "toy-storage"
import { EmbeddingRuntime } from "toy-embedding"
import { FastMemory, fastRelationalSchema, defineFastVectorSchema } from "toy-memory-fast"
import { DIM, FakeRelational, FakeVector, fakeEmbeddingAdapter, fakeVector } from "../test/helpers.mjs"

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
    autoIndex: false, // 示例手动触发补写，便于分步观察
  }),
)

const scope = { userId: "u1", memorySpaceId: "space1" }

try {
  // 1. 追加两条 Fast
  const first = await ctx.memoryFast.append({
    scope,
    sessionId: "s1",
    turnId: "t1",
    drafts: [
      { title: "咖啡偏好", summary: "用户平时喝不加糖的冰美式", body: "- 用户平时喝不加糖的冰美式。" },
      { title: "项目A", summary: "项目A十一月交付", body: "- 项目A十一月交付。" },
    ],
  })
  console.log("append 写入", first.records.length, "条，writeId =", first.writeId)

  // 2. 近期读取（此时向量尚未生成，也能取到）
  const recent = await ctx.memoryFast.listRecentBySession(scope, "s1", 10)
  console.log("listRecentBySession:", recent.map((record) => record.title).join(", "))

  // 3. 补写向量（append 在 autoIndex=true 时会在后台自动触发）
  const indexResult = await ctx.memoryFast.runEmbeddingJobs()
  console.log("runEmbeddingJobs:", indexResult)

  // 4. 双通道检索：标题完全匹配
  const byTitle = await ctx.memoryFast.search({ scope, query: "咖啡偏好", queryVector: null })
  console.log("标题检索命中:", byTitle.hits.map((hit) => `${hit.record.title}[${hit.matchedBy}]`).join(", "))

  // 5. 双通道检索：向量相似（Query 向量由 toy-memory-read 算好传入）
  const byVector = await ctx.memoryFast.search({
    scope,
    query: "冰美式",
    queryVector: fakeVector("用户平时喝不加糖的冰美式"),
  })
  console.log(
    "向量检索命中:",
    byVector.hits.map((hit) => `${hit.record.title}[${hit.matchedBy} score=${hit.vectorScore.toFixed(3)}]`).join(", "),
  )

  // 6. Daily 待处理读取 + 消费计划
  const pending = await ctx.memoryFast.listPendingForDaily(scope)
  console.log("listPendingForDaily:", pending.length, "条未消费")
  const plan = await ctx.memoryFast.prepareConsumption({
    scope,
    batchId: "batch-1",
    fastIds: pending.map((record) => record.fastId),
  })
  console.log("消费计划:", {
    records: plan.records.length,
    vectorIdsToDelete: plan.vectorIdsToDelete.length,
    writeIdsToCancel: plan.writeIdsToCancel.length,
  })
} finally {
  unregister()
  for (const fiber of fibers.reverse()) {
    await fiber.dispose()
  }
}
