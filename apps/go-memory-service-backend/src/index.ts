import { Context } from "cordis"
import { ParallelExecutor } from "toy-parallel-executor"
import { ToyStorage } from "toy-storage"
import { RelationalStorage } from "toy-storage-relational"
import { PostgresStorage } from "toy-storage-postgres"
import { VectorStorage } from "toy-storage-vector"
import { PgvectorStorage } from "toy-storage-pgvector"
import { LlmRuntime } from "toy-llm"
import { OpenAIResponsesPlugin } from "toy-llm-openai-responses"
import { EmbeddingRuntime } from "toy-embedding"
import { EmbeddingOpenAICompatiblePlugin } from "toy-embedding-openai-compatible"
import { JevRuntime } from "toy-jev"
import { JevTypesafePlugin } from "toy-jev-typesafe"
import { JevLlmPlugin } from "toy-jev-llm"
import { HttpServer } from "toy-backend-http"
import { MemoryBackendService } from "toy-backend-memory"
import { MemorySpaceService } from "toy-memory-space"
import { FastMemory } from "toy-memory-fast"
import { LongMemory } from "toy-memory-long"
import { MemoryFeedback } from "toy-memory-feedback"
import { MemoryDaily } from "toy-memory-daily"
import { MemoryRead } from "toy-memory-read"
import { FastWrite } from "toy-memory-write"
import { MemoryScheduler } from "toy-memory-scheduler"
import { MemoryGoBackend } from "toy-memory-go-backend"
import { loadConfig, type ModelChainEntry } from "./config.js"
import { buildRelationalSchema, buildVectorSchema } from "./db-schema.js"

const config = loadConfig(process.env)
const ctx = new Context()

// ① 存储：命名存储 → 关系/向量协议 → Postgres / pgvector 实例
await ctx.plugin(ToyStorage)
await ctx.plugin(RelationalStorage)
await ctx.plugin(PostgresStorage, {
  name: "main",
  connectionString: config.storage.databaseUrl,
  ...(config.storage.schema === undefined ? {} : { schemaName: config.storage.schema }),
  createMissing: true,
  schema: buildRelationalSchema(),
})
await ctx.plugin(VectorStorage)
await ctx.plugin(PgvectorStorage, {
  name: "main",
  connectionString: config.storage.databaseUrl,
  ...(config.storage.schema === undefined ? {} : { schemaName: config.storage.schema }),
  createMissing: true,
  schema: buildVectorSchema(config.embedding.dimensions),
})

// ② 模型路由：按 YAML 注册 adapter 与降级链（LLM / Embedding / JEV）
await ctx.plugin(LlmRuntime)
for (const [name, adapter] of Object.entries(config.llm.adapters)) {
  await ctx.plugin(OpenAIResponsesPlugin, {
    provider: name,
    baseURL: adapter.baseURL,
    ...(adapter.apiKey === undefined ? {} : { apiKey: adapter.apiKey }),
    store: true,
  })
}
for (const [name, entries] of Object.entries(config.llm.chains)) {
  ctx.llm.registerChain(name, entries)
}

await ctx.plugin(EmbeddingRuntime)
for (const [name, adapter] of Object.entries(config.embedding.adapters)) {
  await ctx.plugin(EmbeddingOpenAICompatiblePlugin, {
    provider: name,
    baseURL: adapter.baseURL,
    ...(adapter.apiKey === undefined ? {} : { apiKey: adapter.apiKey }),
    dimensions: config.embedding.dimensions,
  })
}
for (const [name, entries] of Object.entries(config.embedding.chains)) {
  ctx.embedding.registerChain(name, entries)
}

await ctx.plugin(JevRuntime)
const hasJev = Object.keys(config.jev.adapters).length > 0
if (hasJev) {
  for (const [name, adapter] of Object.entries(config.jev.adapters)) {
    if (adapter.type === "typesafe") {
      await ctx.plugin(JevTypesafePlugin, {
        provider: name,
        baseURL: adapter.baseURL,
        apiKey: adapter.apiKey,
      })
    } else {
      await ctx.plugin(JevLlmPlugin, {
        provider: name,
        llmProvider: adapter.llmProvider,
        ...(adapter.temperature === undefined ? {} : { temperature: adapter.temperature }),
        ...(adapter.maxTokens === undefined ? {} : { maxTokens: adapter.maxTokens }),
      })
    }
  }
  for (const [name, providers] of Object.entries(config.jev.chains)) {
    ctx.jev.registerChain(name, providers)
  }
}
const dailyJevProvider = hasJev ? config.memory.daily.jev : ""

// ③ 记忆服务：空间 / 证据 / 长期 / 反馈 / 检索 / 写入 / Daily / 调度
await ctx.plugin(MemorySpaceService)
await ctx.plugin(FastMemory, {
  embeddingProvider: config.memory.embedding,
  embeddingModel: primaryModel(config.embedding.chains, config.memory.embedding),
})
await ctx.plugin(LongMemory)
await ctx.plugin(MemoryFeedback)
await ctx.plugin(MemoryRead, {
  embeddingProvider: config.memory.embedding,
  embeddingModel: primaryModel(config.embedding.chains, config.memory.embedding),
})
await ctx.plugin(FastWrite, {
  llmProvider: config.memory.extract.llm,
  llmModel: primaryModel(config.llm.chains, config.memory.extract.llm),
})
// Daily 依赖任务池；缺少时 Cordis 会挂起 Daily、Scheduler 和 HTTP 门面。
await ctx.plugin(ParallelExecutor)
await ctx.plugin(MemoryDaily, {
  llmProvider: config.memory.daily.llm,
  llmModel: primaryModel(config.llm.chains, config.memory.daily.llm),
  jevProvider: dailyJevProvider,
  embeddingProvider: config.memory.daily.embedding,
  embeddingModel: primaryModel(config.embedding.chains, config.memory.daily.embedding),
})
await ctx.plugin(MemoryScheduler)

// ④ HTTP：服务 + Go 读写门面 + 运维查看门面
await ctx.plugin(HttpServer, { host: config.http.host, port: config.http.port })
await ctx.plugin(MemoryBackendService)
await ctx.plugin(MemoryGoBackend, {
  ...(config.memory.scheduler.dailyAt === undefined
    ? {}
    : { dailyAt: config.memory.scheduler.dailyAt }),
  timeZone: config.memory.scheduler.timeZone,
  minPendingFast: config.memory.scheduler.minPendingFast,
})

// HTTP 端口监听不代表业务插件已激活；依赖缺失时不能报告启动成功。
if (!ctx.memoryGoBackend || !ctx.memoryBackend || !ctx.memoryScheduler) {
  await ctx.fiber.dispose()
  throw new Error("记忆服务未就绪：检查 MemoryGoBackend / MemoryBackend / MemoryScheduler 的插件依赖")
}

await ctx.http.ready

const bound = ctx.http.address()
console.log(`go memory service backend listening on http://${bound?.host}:${bound?.port}`)
console.log(`  PostgreSQL：${maskUrl(config.storage.databaseUrl)}`)
console.log(`  LLM chains：${Object.keys(config.llm.chains).join(", ")}`)
console.log(`  Embedding chains：${Object.keys(config.embedding.chains).join(", ")}`)
console.log(`  JEV chains：${Object.keys(config.jev.chains).join(", ") || "（未配置）"}`)
console.log("  Go 调用路由：")
console.log("    POST /memory/read")
console.log("    POST /memory/write")

/** 取链的首个候选 model 作为占位（provider 指向链时，链内 entry 会覆盖 model）。 */
function primaryModel(chains: Record<string, readonly ModelChainEntry[]>, name: string): string {
  return chains[name]?.[0]?.model ?? "default"
}

/** 隐藏连接串中的口令，仅打印便于观测的摘要。 */
function maskUrl(connectionString: string): string {
  try {
    const url = new URL(connectionString)
    const user = url.username ? "***@" : ""
    return `${url.protocol}//${user}${url.host}${url.pathname}`
  } catch {
    return "***"
  }
}

/** 优雅停机：卸载服务（关闭 HTTP、数据库连接与调度器定时器）。 */
async function shutdown(signal: string): Promise<void> {
  console.log(`\n收到 ${signal}，开始优雅停机…`)
  await ctx.fiber.dispose()
  console.log("已停机")
  process.exit(0)
}

process.once("SIGINT", () => void shutdown("SIGINT"))
process.once("SIGTERM", () => void shutdown("SIGTERM"))
