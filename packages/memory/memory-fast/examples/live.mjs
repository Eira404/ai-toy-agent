/* global console */
import { Context } from "cordis"
import { ToyStorage } from "toy-storage"
import { RelationalStorage } from "toy-storage-relational"
import { VectorStorage } from "toy-storage-vector"
import { PostgresStorage } from "toy-storage-postgres"
import { PgvectorStorage } from "toy-storage-pgvector"
import { EmbeddingRuntime } from "toy-embedding"
import { EmbeddingOpenAICompatiblePlugin } from "toy-embedding-openai-compatible"
import { FastMemory, fastRelationalSchema, defineFastVectorSchema } from "toy-memory-fast"

const connectionString = process.env.DATABASE_URL
const baseURL = process.env.DASHSCOPE_EMBEDDING_BASE_URL
const apiKey = process.env.DASHSCOPE_API_KEY
if (!connectionString || !baseURL || !apiKey) {
  console.error("缺少环境变量：DATABASE_URL / DASHSCOPE_EMBEDDING_BASE_URL / DASHSCOPE_API_KEY")
  process.exit(1)
}

const MODEL = "qwen3.7-text-embedding-flash"
const DIMENSIONS = 1024
const scope = { userId: "u-live", memorySpaceId: "space-live" }

const ctx = new Context()
const fibers = []
fibers.push(await ctx.plugin(ToyStorage))
fibers.push(await ctx.plugin(RelationalStorage))
fibers.push(await ctx.plugin(VectorStorage))
fibers.push(
  await ctx.plugin(PostgresStorage, {
    name: "main",
    connectionString,
    createMissing: true,
    schema: fastRelationalSchema,
  }),
)
fibers.push(
  await ctx.plugin(PgvectorStorage, {
    name: "main",
    connectionString,
    createMissing: true,
    schema: defineFastVectorSchema(DIMENSIONS),
  }),
)
fibers.push(await ctx.plugin(EmbeddingRuntime))
fibers.push(
  await ctx.plugin(EmbeddingOpenAICompatiblePlugin, {
    provider: "dashscope",
    baseURL,
    apiKey,
    dimensions: DIMENSIONS,
    timeoutMs: 30_000,
  }),
)
fibers.push(
  await ctx.plugin(FastMemory, {
    embeddingProvider: "dashscope",
    embeddingModel: MODEL,
    autoIndex: false, // 手动触发补写，便于分步观察
  }),
)

try {
  // 1. 追加 Fast（真实 PostgreSQL + pgvector）
  const appended = await ctx.memoryFast.append({
    scope,
    sessionId: "live-session",
    turnId: "live-turn-1",
    drafts: [
      { title: "咖啡偏好", summary: "用户平时喝不加糖的冰美式", body: "- 用户平时喝不加糖的冰美式。" },
      { title: "居住地", summary: "用户目前住在杭州", body: "- 用户目前住在杭州。" },
    ],
  })
  console.log("1) append 写入", appended.records.length, "条，writeId =", appended.writeId)

  // 2. 真实 Embedding 补写向量
  const indexed = await ctx.memoryFast.runEmbeddingJobs()
  console.log("2) runEmbeddingJobs:", indexed)

  // 3. 用真实 Embedding 生成 Query 向量，再做向量检索
  const queryEmbed = await ctx.embedding.embed({
    provider: "dashscope",
    model: MODEL,
    texts: ["用户喝什么咖啡"],
  })
  const byVector = await ctx.memoryFast.search({
    scope,
    query: "喝咖啡",
    queryVector: queryEmbed.vectors[0],
  })
  console.log(
    "3) 向量检索:",
    byVector.hits.map((hit) => ({
      title: hit.record.title,
      matchedBy: hit.matchedBy,
      score: hit.vectorScore === null ? null : Number(hit.vectorScore.toFixed(4)),
    })),
  )

  // 4. 标题完全匹配（不依赖向量）
  const byTitle = await ctx.memoryFast.search({ scope, query: "咖啡偏好", queryVector: null })
  console.log(
    "4) 标题检索:",
    byTitle.hits.map((hit) => `${hit.record.title}[${hit.matchedBy}]`),
  )

  // 5. Daily 待处理读取
  const pending = await ctx.memoryFast.listPendingForDaily(scope)
  console.log("5) listPendingForDaily:", pending.length, "条未消费")
} finally {
  for (const fiber of fibers.reverse()) {
    await fiber.dispose()
  }
}
