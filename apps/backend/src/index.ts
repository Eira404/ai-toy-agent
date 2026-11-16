import { Context } from "cordis"
import { AgentService } from "toy-agent"
import { AgentLoop, SystemPromptAssembler } from "toy-agent-loop"
import { AgentBackendService } from "toy-backend-agent"
import { HttpServer } from "toy-backend-http"
import { LlmRuntime } from "toy-llm"
import { OpenAIResponsesPlugin } from "toy-llm-openai-responses"
import { SessionData } from "toy-session-data"
import { ToySession } from "toy-session"
import { SessionStorage } from "toy-session-storage"
import { ToyStorage } from "toy-storage"
import { PostgresStorage } from "toy-storage-postgres"
import { RelationalStorage } from "toy-storage-relational"
import { StorageWriteQueue } from "toy-storage-write-queue"
import { ToolRegistry } from "toy-tools"
import { JevRuntime } from "toy-jev"
import { JevTypesafePlugin } from "toy-jev-typesafe"
import { ToyIntentAnalysis } from "toy-intent-analysis"
import { ToyEmotionAnalysis } from "toy-emotion-analysis"
import { ToyQueryAnalysis } from "toy-query-analysis"
import { ToyRiskAnalysis } from "toy-risk-analysis"
import { ToySubdomainAnalysis } from "toy-subdomain-analysis"
import { ToyModeAnalysis } from "toy-mode-analysis"
import { DebugUsers } from "toy-debug-user"
import { DebugDevices } from "toy-debug-device"
import { DebugBackendService } from "toy-debug-backend"
import { DeviceService } from "toy-device"
import { DeviceContext } from "toy-device-lifecycle"
import { MemorySpaceService } from "toy-memory-space"
import { FastMemory } from "toy-memory-fast"
import { LongMemory } from "toy-memory-long"
import { MemoryFeedback } from "toy-memory-feedback"
import { MemoryDaily } from "toy-memory-daily"
import { MemoryRead } from "toy-memory-read"
import { FastWrite } from "toy-memory-write"
import { MemoryOnline } from "toy-memory-lifecycle"
import { MemoryBackendService } from "toy-backend-memory"
import { VectorStorage } from "toy-storage-vector"
import { PgvectorStorage } from "toy-storage-pgvector"
import { EmbeddingRuntime } from "toy-embedding"
import { EmbeddingOpenAICompatiblePlugin } from "toy-embedding-openai-compatible"
import { ParallelExecutor } from "toy-parallel-executor"
import { buildRelationalSchema, buildVectorSchema } from "./db-schema.js"

const host = process.env.HOST ?? "127.0.0.1"
const port = Number.parseInt(process.env.PORT ?? "3000", 10)
const provider = process.env.LLM_PROVIDER ?? "dashscope"
const model = process.env.LLM_MODEL ?? "qwen3.7-max"
const systemPrompt = process.env.SYSTEM_PROMPT ?? "你是玩具设备中的中文助手。"
const debugBackend = process.env.DEBUG_BACKEND === "1"
const embeddingModel = process.env.EMBEDDING_MODEL ?? "qwen3.7-text-embedding-flash"
const embeddingDimensions = 1024

const connectionString = process.env.DATABASE_URL
if (!connectionString) {
  throw new Error("请先设置 DATABASE_URL（PostgreSQL 连接串），本后端需要持久化 Session。")
}
const baseUrl = process.env.DASHSCOPE_RESPONSES_BASE_URL
if (!baseUrl) {
  throw new Error("请先设置 DASHSCOPE_RESPONSES_BASE_URL，本后端使用 Responses API。")
}

const ctx = new Context()

// ① 持久化：命名存储 → 关系协议 → 写队列 → Postgres 实例 → Session 存储
await ctx.plugin(ToyStorage)
await ctx.plugin(RelationalStorage)
await ctx.plugin(StorageWriteQueue)
await ctx.plugin(PostgresStorage, {
  name: "main",
  connectionString,
  ...(process.env.DB_SCHEMA === undefined ? {} : { schemaName: process.env.DB_SCHEMA }),
  createMissing: true,
  schema: buildRelationalSchema({ debugBackend }),
})
await ctx.plugin(SessionStorage, { sourceName: "main" })

// ①b 向量存储（Fast/Long 向量索引）
await ctx.plugin(VectorStorage)
await ctx.plugin(PgvectorStorage, {
  name: "main",
  connectionString,
  ...(process.env.DB_SCHEMA === undefined ? {} : { schemaName: process.env.DB_SCHEMA }),
  createMissing: true,
  schema: buildVectorSchema(embeddingDimensions),
})

// ② 模型路由（Responses API）
await ctx.plugin(LlmRuntime)
await ctx.plugin(OpenAIResponsesPlugin, {
  baseURL: baseUrl,
  ...(process.env.DASHSCOPE_API_KEY === undefined ? {} : { apiKey: process.env.DASHSCOPE_API_KEY }),
  provider,
  store: true,
})

// ②b Embedding（Fast/Long 向量生成）
await ctx.plugin(EmbeddingRuntime)
await ctx.plugin(EmbeddingOpenAICompatiblePlugin, {
  provider: "dashscope",
  baseURL: process.env.DASHSCOPE_EMBEDDING_BASE_URL ?? "",
  ...(process.env.DASHSCOPE_API_KEY === undefined ? {} : { apiKey: process.env.DASHSCOPE_API_KEY }),
  dimensions: embeddingDimensions,
})

// ③ 工具
await ctx.plugin(ToolRegistry)
// 示例工具：便于观察工具调用链路（模型在需要时调用）
ctx.tools.register({
  name: "get_current_time",
  description: "获取服务器当前时间",
  parameters: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
  execute: () => ({
    iso: new Date().toISOString(),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  }),
})

// ④ 会话 + Agent 循环（SessionData 会检测到 sessionStorage，进入 persistent 模式）
await ctx.plugin(SessionData)
await ctx.plugin(ToySession)
await ctx.plugin(AgentService)
await ctx.plugin(AgentLoop, { provider, model, systemPrompt, reasoning: { enabled: false } })
await ctx.plugin(SystemPromptAssembler)

// ⑤ 结构化评估（JEV）+ 分析插件（预处理节点，基本并行）
await ctx.plugin(JevRuntime)
await ctx.plugin(JevTypesafePlugin, {
  provider: "typesafe",
  baseURL: process.env.JEV_BASE_URL ?? "",
  apiKey: process.env.JEV_API_KEY ?? "",
})
ctx.jev.registerChain("jev-main", [
  { provider: "typesafe", model: process.env.JEV_MODEL ?? "jev-1.14.0" },
])
await ctx.plugin(ToyQueryAnalysis, { provider, model })
await ctx.plugin(ToyIntentAnalysis, { strategy: "jev", provider: "jev-main" })
await ctx.plugin(ToyEmotionAnalysis, { provider: "jev-main" })
await ctx.plugin(ToyRiskAnalysis, { provider: "jev-main" })
await ctx.plugin(ToySubdomainAnalysis, { provider: "jev-main" })
await ctx.plugin(ToyModeAnalysis, { provider: "jev-main" })

// ⑤b 记忆服务（空间 + 证据 + 长期 + 反馈 + 检索 + 写入 + Daily + 在线门控）
await ctx.plugin(MemorySpaceService)
await ctx.plugin(FastMemory, { embeddingProvider: "dashscope", embeddingModel })
await ctx.plugin(LongMemory)
await ctx.plugin(MemoryFeedback)
await ctx.plugin(MemoryRead, { embeddingProvider: "dashscope", embeddingModel })
await ctx.plugin(FastWrite, { llmProvider: provider, llmModel: model })
await ctx.plugin(ParallelExecutor)
await ctx.plugin(MemoryDaily, {
  llmProvider: provider,
  llmModel: model,
  jevProvider: "jev-main",
  embeddingProvider: "dashscope",
  embeddingModel,
})
await ctx.plugin(MemoryOnline, { provider: "jev-main" })

// ⑥ 后端 HTTP 服务（+ agentBackend 路由）
await ctx.plugin(HttpServer, { host, port })
await ctx.plugin(AgentBackendService)
await ctx.plugin(MemoryBackendService)
if (debugBackend) {
  await ctx.plugin(DebugUsers, { sourceName: "main" })
  await ctx.plugin(DebugDevices, { sourceName: "main" })
  await ctx.plugin(DeviceService)
  await ctx.plugin(DeviceContext)
  await ctx.plugin(DebugBackendService)
}
await ctx.http.ready

const bound = ctx.http.address()
console.log(`backend server listening on http://${bound?.host}:${bound?.port}`)
console.log(`  持久化：PostgreSQL · 模型：${provider}/${model}（Responses API）`)
console.log("  路由：")
console.log("    POST /agentBackend/createSession")
console.log("    POST /agentBackend/runTurn/:sessionId")
console.log("    POST /agentBackend/runTurnStream/:sessionId  (SSE 流式)")
if (debugBackend) {
  console.log("  debug 路由（DEBUG_BACKEND=1）：")
  console.log("    POST /debug/createUser · /debug/ensureUser · /debug/seedUsers")
  console.log("    GET  /debug/getUser/:userId · /debug/listUsers")
  console.log("    POST /debug/updateUser/:userId · DELETE /debug/deleteUser/:userId")
  console.log("    POST /debug/createDevice · /debug/ensureDevice · /debug/seedDevices")
  console.log("    GET  /debug/getDevice/:deviceId · /debug/listDevices")
  console.log("    POST /debug/updateDevice/:deviceId · DELETE /debug/deleteDevice/:deviceId")
}

/** 优雅停机：先排空后台任务，再卸载（关闭 HTTP 服务与数据库连接）。 */
async function shutdown(signal: string): Promise<void> {
  console.log(`\n收到 ${signal}，开始优雅停机…`)
  await ctx.agentLoop.waitForIdle()
  await ctx.session.waitForPostprocessing()
  await ctx.fiber.dispose()
  console.log("已停机")
  process.exit(0)
}

process.once("SIGINT", () => void shutdown("SIGINT"))
process.once("SIGTERM", () => void shutdown("SIGTERM"))
