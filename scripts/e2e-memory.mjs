/* global console */
// 端到端跑通记忆系统核心闭环：真实 PostgreSQL + pgvector + LLM/JEV/Embedding，无价值引擎。
// 运行：node --env-file=.env scripts/e2e-memory.mjs
import { Context } from "cordis"
import { ToyStorage } from "toy-storage"
import { RelationalStorage } from "toy-storage-relational"
import { VectorStorage } from "toy-storage-vector"
import { PostgresStorage } from "toy-storage-postgres"
import { PgvectorStorage } from "toy-storage-pgvector"
import { EmbeddingRuntime } from "toy-embedding"
import { EmbeddingOpenAICompatiblePlugin } from "toy-embedding-openai-compatible"
import { LlmRuntime } from "toy-llm"
import { OpenAIResponsesPlugin } from "toy-llm-openai-responses"
import { JevRuntime } from "toy-jev"
import { JevTypesafePlugin } from "toy-jev-typesafe"
import { MemorySpaceService, spaceRelationalSchema } from "toy-memory-space"
import { FastMemory, fastRelationalSchema, defineFastVectorSchema } from "toy-memory-fast"
import { LongMemory, longRelationalSchema, defineLongVectorSchema } from "toy-memory-long"
import { MemoryFeedback, feedbackRelationalSchema } from "toy-memory-feedback"
import { ParallelExecutor } from "toy-parallel-executor"
import { FastWrite } from "toy-memory-write"
import { MemoryRead } from "toy-memory-read"
import { MemoryDaily, dailyRelationalSchema } from "toy-memory-daily"

const DIMENSIONS = 1024
const LLM_MODEL = process.env.LLM_MODEL ?? "qwen3.7-max"
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL ?? "qwen3.7-text-embedding-flash"
const JEV_MODEL = process.env.JEV_MODEL ?? "jev-1.14.0"

const mergedRelationalSchema = {
  tables: {
    ...spaceRelationalSchema.tables,
    ...fastRelationalSchema.tables,
    ...longRelationalSchema.tables,
    ...feedbackRelationalSchema.tables,
    ...dailyRelationalSchema.tables,
  },
}

const mergedVectorSchema = {
  collections: {
    ...defineFastVectorSchema(DIMENSIONS).collections,
    ...defineLongVectorSchema(DIMENSIONS).collections,
  },
}

const ctx = new Context()
const fibers = []

// 存储
fibers.push(await ctx.plugin(ToyStorage))
fibers.push(await ctx.plugin(RelationalStorage))
fibers.push(await ctx.plugin(VectorStorage))
fibers.push(
  await ctx.plugin(PostgresStorage, {
    name: "main",
    connectionString: process.env.DATABASE_URL,
    createMissing: true,
    schema: mergedRelationalSchema,
  }),
)
fibers.push(
  await ctx.plugin(PgvectorStorage, {
    name: "main",
    connectionString: process.env.DATABASE_URL,
    createMissing: true,
    schema: mergedVectorSchema,
  }),
)

// 模型
fibers.push(await ctx.plugin(EmbeddingRuntime))
fibers.push(
  await ctx.plugin(EmbeddingOpenAICompatiblePlugin, {
    provider: "dashscope",
    baseURL: process.env.DASHSCOPE_EMBEDDING_BASE_URL,
    apiKey: process.env.DASHSCOPE_API_KEY,
    dimensions: DIMENSIONS,
    timeoutMs: 30_000,
  }),
)
fibers.push(await ctx.plugin(LlmRuntime))
fibers.push(
  await ctx.plugin(OpenAIResponsesPlugin, {
    provider: "dashscope",
    baseURL: process.env.DASHSCOPE_RESPONSES_BASE_URL,
    apiKey: process.env.DASHSCOPE_API_KEY,
  }),
)
fibers.push(await ctx.plugin(JevRuntime))
fibers.push(
  await ctx.plugin(JevTypesafePlugin, {
    provider: "typesafe",
    baseURL: process.env.JEV_BASE_URL,
    apiKey: process.env.JEV_API_KEY,
    model: JEV_MODEL,
  }),
)

// 记忆服务
fibers.push(await ctx.plugin(MemorySpaceService))
fibers.push(
  await ctx.plugin(FastMemory, {
    embeddingProvider: "dashscope",
    embeddingModel: EMBEDDING_MODEL,
    autoIndex: false,
  }),
)
fibers.push(await ctx.plugin(LongMemory))
fibers.push(await ctx.plugin(MemoryFeedback))
fibers.push(await ctx.plugin(FastWrite, { llmProvider: "dashscope", llmModel: LLM_MODEL }))
fibers.push(
  await ctx.plugin(MemoryRead, {
    embeddingProvider: "dashscope",
    embeddingModel: EMBEDDING_MODEL,
  }),
)
fibers.push(await ctx.plugin(ParallelExecutor))
fibers.push(
  await ctx.plugin(MemoryDaily, {
    llmProvider: "dashscope",
    llmModel: LLM_MODEL,
    jevProvider: "typesafe",
    embeddingProvider: "dashscope",
    embeddingModel: EMBEDDING_MODEL,
  }),
)

const userId = "e2e-user"

try {
  // 1) 创建空间 + 绑定娃娃
  const space = await ctx.memorySpace.createSpace({ userId, name: "E2E 空间" })
  await ctx.memorySpace.bindDevice({ userId, deviceId: "e2e-device", memorySpaceId: space.memorySpaceId })
  const scope = { userId, memorySpaceId: space.memorySpaceId }
  console.log("1) 空间", space.memorySpaceId, "已创建并绑定")

  // 2) Turn 提取 → Fast（真 LLM）
  const extracted = await ctx.memoryWrite.extract(
    {
      scope,
      sessionId: "e2e-session",
      turnId: "e2e-turn-1",
      userMessage: "我喜欢喝不加糖的冰美式",
      recentConversation: [],
    },
    "written",
  )
  console.log(
    "2) 提取 Fast:",
    extracted.kind,
    extracted.kind === "written" ? extracted.records.map((r) => r.title).join(", ") : "",
  )

  // 2b) 补写 Fast 向量（真实 Embedding），使检索可命中
  const indexed = await ctx.memoryFast.runEmbeddingJobs()
  console.log("2b) 补写 Fast 向量:", indexed.completed, "条")

  // 3) 检索（此时只有 Fast）
  const before = await ctx.memoryRead.search({ scope, query: "咖啡", mode: "weak" })
  console.log(
    "3) 检索(每日整理前): Fast",
    before.fast.hits.length,
    "Long",
    before.long.blocks.length,
  )

  // 4) Daily：Fast → Long（真 LLM + JEV + Embedding）
  const run = await ctx.memoryDaily.runDaily(scope)
  console.log("4) Daily 批次", run.batchId, "完成")

  // 5) 检索（此时应有 Long）
  const after = await ctx.memoryRead.search({ scope, query: "咖啡", mode: "weak" })
  console.log(
    "5) 检索(每日整理后): Fast",
    after.fast.hits.length,
    "Long",
    after.long.blocks.map((b) => `${b.title}[${b.reason}]`).join(", "),
  )
} finally {
  for (const fiber of fibers.reverse()) {
    await fiber.dispose()
  }
}
