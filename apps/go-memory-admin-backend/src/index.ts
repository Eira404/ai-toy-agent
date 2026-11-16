import { Context } from "cordis"
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
import { ParallelExecutor } from "toy-parallel-executor"
import { MemorySpaceService } from "toy-memory-space"
import { FastMemory } from "toy-memory-fast"
import { LongMemory } from "toy-memory-long"
import { MemoryFeedback } from "toy-memory-feedback"
import { MemoryDaily } from "toy-memory-daily"
import { AdminAuth, AdminAuthError } from "toy-admin-auth"
import { Admin } from "toy-admin"
import { AdminBackendService } from "toy-admin-backend"
import { HttpServer } from "toy-backend-http"
import { MemoryGoAdmin } from "toy-memory-go-admin"
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

// ② 模型路由：按 config.yaml 注册 adapter 与降级链（LLM / Embedding / JEV）
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
    if (adapter.type !== "typesafe") {
      throw new Error(`admin 后端仅支持 typesafe JEV adapter，不支持 '${adapter.type}'`)
    }
    await ctx.plugin(JevTypesafePlugin, {
      provider: name,
      baseURL: adapter.baseURL,
      apiKey: adapter.apiKey,
    })
  }
  for (const [name, providers] of Object.entries(config.jev.chains)) {
    ctx.jev.registerChain(name, providers)
  }
}
const dailyJevProvider = hasJev ? config.memory.daily.jev : ""

// ③ 记忆服务：空间 / 证据 / 长期（浏览）+ 反馈 / Daily（手动触发）
await ctx.plugin(MemorySpaceService)
await ctx.plugin(FastMemory, { embeddingProvider: "none", embeddingModel: "none" })
await ctx.plugin(LongMemory)
await ctx.plugin(MemoryFeedback)
// Daily 依赖任务池；缺少时 Cordis 会挂起 Daily。
await ctx.plugin(ParallelExecutor)
await ctx.plugin(MemoryDaily, {
  llmProvider: config.memory.daily.llm,
  llmModel: primaryModel(config.llm.chains, config.memory.daily.llm),
  jevProvider: dailyJevProvider,
  embeddingProvider: config.memory.daily.embedding,
  embeddingModel: primaryModel(config.embedding.chains, config.memory.daily.embedding),
})

// ④ 管理员栈：认证 → 能力总包 → HTTP → 能力路由 → 记忆运维能力
await ctx.plugin(AdminAuth)
await ctx.plugin(Admin)
await ctx.plugin(HttpServer, { host: config.http.host, port: config.http.port })
await ctx.plugin(AdminBackendService, { mountPath: config.admin.mountPath })
await ctx.plugin(MemoryGoAdmin)

// ⑤ 首个 superadmin（幂等：已初始化则跳过）
if (config.admin.bootstrapPassword !== undefined) {
  try {
    await ctx.adminAuth.bootstrap({
      loginName: config.admin.bootstrapLogin,
      password: config.admin.bootstrapPassword,
    })
    console.log(`已创建首个管理员：${config.admin.bootstrapLogin}`)
  } catch (error) {
    if (error instanceof AdminAuthError && error.code === "already-initialized") {
      console.log("管理员已初始化，跳过 bootstrap")
    } else {
      throw error
    }
  }
} else {
  console.log("未设置 ADMIN_BOOTSTRAP_PASSWORD，跳过首个管理员创建（首次启动请设置）")
}

await ctx.http.ready

const bound = ctx.http.address()
const p = config.admin.mountPath
console.log(`go memory admin backend listening on http://${bound?.host}:${bound?.port}`)
console.log(`  admin 路由挂载于：${p}`)
console.log(`  账号端点：POST ${p}/login`)
console.log(`  记忆运维：GET  ${p}/memory/users`)
console.log(`           GET  ${p}/memory/user-overview?userId=...`)
console.log(`           GET  ${p}/memory/fast?memorySpaceId=...`)
console.log(`           GET  ${p}/memory/fast-detail?memorySpaceId=...&fastId=...`)
console.log(`           GET  ${p}/memory/long?memorySpaceId=...`)
console.log(`           GET  ${p}/memory/long-detail?memorySpaceId=...&blockId=...`)
console.log(`           POST ${p}/memory/run-daily  (superadmin，手动触发 Daily)`)
console.log(`           GET  ${p}/memory/daily-status?batchId=...`)

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

console.log(`  PostgreSQL：${maskUrl(config.storage.databaseUrl)}`)

/** 优雅停机：先排空在途管理调用，再卸载（关闭 HTTP 与数据库连接）。 */
async function shutdown(signal: string): Promise<void> {
  console.log(`\n收到 ${signal}，开始优雅停机…`)
  ctx.admin.stop()
  await ctx.admin.waitForIdle({ timeoutMs: 5000 })
  await ctx.fiber.dispose()
  console.log("已停机")
  process.exit(0)
}

process.once("SIGINT", () => void shutdown("SIGINT"))
process.once("SIGTERM", () => void shutdown("SIGTERM"))
