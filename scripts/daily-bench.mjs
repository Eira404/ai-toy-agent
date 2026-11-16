/* global console, performance, structuredClone */
// 真实模型跑一遍 Daily，数据不落库（内存 fake relational + fake vector）。
// 运行：node --env-file=.env scripts/daily-bench.mjs
import { Context, Service } from "cordis"
import { ToyStorage } from "toy-storage"
import { RelationalStorage } from "toy-storage-relational"
import { EmbeddingRuntime } from "toy-embedding"
import { EmbeddingOpenAICompatiblePlugin } from "toy-embedding-openai-compatible"
import { LlmRuntime } from "toy-llm"
import { OpenAIResponsesPlugin } from "toy-llm-openai-responses"
import { JevRuntime } from "toy-jev"
import { JevTypesafePlugin } from "toy-jev-typesafe"
import { FastMemory, fastRelationalSchema, defineFastVectorSchema } from "toy-memory-fast"
import { LongMemory, longRelationalSchema, defineLongVectorSchema } from "toy-memory-long"
import { MemoryFeedback, feedbackRelationalSchema } from "toy-memory-feedback"
import { ParallelExecutor } from "toy-parallel-executor"
import { MemoryDaily, dailyRelationalSchema } from "toy-memory-daily"

const DIM = 1024
const LLM_MODEL = process.env.LLM_MODEL ?? "qwen3.7-max"
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL ?? "qwen3.7-text-embedding-flash"
const JEV_MODEL = process.env.JEV_MODEL ?? "jev-latest"

// ---------------------------------------------------------------------------
// 内存 fake：关系型 + 向量（与 memory-daily 单元测试同款，仅内存、不落库）
// ---------------------------------------------------------------------------

function compare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0
}

function matches(row, filter) {
  switch (filter.type) {
    case "eq":
      return row[filter.field] === filter.value
    case "ne":
      return row[filter.field] !== filter.value
    case "lt":
      return row[filter.field] < filter.value
    case "lte":
      return row[filter.field] <= filter.value
    case "in":
      return filter.values.includes(row[filter.field])
    case "isNull":
      return row[filter.field] === null || row[filter.field] === undefined
    case "and":
      return filter.conditions.every((item) => matches(row, item))
    case "or":
      return filter.conditions.some((item) => matches(row, item))
    default:
      throw new Error(`fake relational 不支持 filter ${filter.type}`)
  }
}

function violatesUniqueIndex(schema, tableName, table, row, ignoredKey) {
  const indexes = schema.tables[tableName].indexes ?? []
  for (const index of indexes) {
    if (!index.unique) continue
    const key = index.fields.map((field) => row[field]).join("\u0000")
    if (key === ignoredKey) continue
    for (const [existingKey, existing] of table) {
      const existingIndexKey = index.fields.map((field) => existing[field]).join("\u0000")
      if (existingIndexKey === key) return true
    }
  }
  return false
}

class FakeRelational extends Service {
  static inject = ["storage"]

  constructor(ctx, config) {
    super(ctx, "fakeRelational")
    this.schema = config.schema
    this.rows = new Map(Object.keys(this.schema.tables).map((name) => [name, new Map()]))
  }

  [Service.init]() {
    this.ctx.storage.register("relational", "main", this)
  }

  async execute(operation) {
    const table = this.rows.get(operation.table)
    const primary = this.schema.tables[operation.table].primaryKey
    switch (operation.type) {
      case "insert": {
        const row = structuredClone(operation.value)
        if (table.has(row[primary]) || violatesUniqueIndex(this.schema, operation.table, table, row, null)) {
          throw new Error("duplicate key")
        }
        table.set(row[primary], row)
        return { row: structuredClone(row) }
      }
      case "insertMany": {
        const rows = []
        for (const value of operation.values) {
          const row = structuredClone(value)
          if (table.has(row[primary]) || violatesUniqueIndex(this.schema, operation.table, table, row, null)) {
            throw new Error("duplicate key")
          }
          table.set(row[primary], row)
          rows.push(structuredClone(row))
        }
        return { rows }
      }
      case "upsert": {
        const row = structuredClone(operation.value)
        const inserted = !table.has(row[primary])
        if (violatesUniqueIndex(this.schema, operation.table, table, row, row[primary])) {
          throw new Error("duplicate key")
        }
        table.set(row[primary], row)
        return { row: structuredClone(row), inserted }
      }
      case "get": {
        const row = table.get(operation.key)
        return { row: row === undefined ? undefined : structuredClone(row) }
      }
      case "find": {
        const rows = [...table.values()].filter(
          (row) => operation.where === undefined || matches(row, operation.where),
        )
        for (const order of [...(operation.orderBy ?? [])].reverse()) {
          rows.sort(
            (left, right) =>
              compare(left[order.field], right[order.field]) * (order.direction === "desc" ? -1 : 1),
          )
        }
        const start = operation.offset ?? 0
        const end = operation.limit === undefined ? rows.length : start + operation.limit
        return { rows: structuredClone(rows.slice(start, end)) }
      }
      case "count": {
        const rows = [...table.values()].filter(
          (row) => operation.where === undefined || matches(row, operation.where),
        )
        return { count: rows.length }
      }
      case "update": {
        let affectedRows = 0
        for (const row of table.values()) {
          if (operation.where !== undefined && !matches(row, operation.where)) continue
          Object.assign(row, structuredClone(operation.patch))
          affectedRows += 1
        }
        return { affectedRows }
      }
      case "delete": {
        let affectedRows = 0
        for (const [key, row] of [...table]) {
          if (operation.where !== undefined && !matches(row, operation.where)) continue
          table.delete(key)
          affectedRows += 1
        }
        return { affectedRows }
      }
      default:
        throw new Error(`fake relational 不支持 ${operation.type}`)
    }
  }

  async transaction(callback) {
    const snapshot = new Map()
    for (const [name, map] of this.rows) {
      snapshot.set(name, new Map([...map].map(([key, value]) => [key, structuredClone(value)])))
    }
    try {
      return await callback({ execute: (operation) => this.execute(operation) })
    } catch (error) {
      this.rows.clear()
      for (const [name, map] of snapshot) {
        this.rows.set(name, map)
      }
      throw error
    }
  }
}

function cosineDistance(left, right) {
  let dot = 0
  let leftNorm = 0
  let rightNorm = 0
  for (let i = 0; i < left.length; i += 1) {
    dot += left[i] * right[i]
    leftNorm += left[i] * left[i]
    rightNorm += right[i] * right[i]
  }
  if (leftNorm === 0 || rightNorm === 0) return 1
  return 1 - dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm))
}

function matchesVectorFilter(record, filter) {
  if (filter === undefined) return true
  if (filter.type === "eq") return record.fields[filter.field] === filter.value
  if (filter.type === "and") return filter.conditions.every((condition) => matchesVectorFilter(record, condition))
  throw new Error(`fake vector 不支持 filter ${filter.type}`)
}

class FakeVector extends Service {
  static inject = ["storage"]

  constructor(ctx, config) {
    super(ctx, "fakeVector")
    this.schema = config.schema
    this.records = new Map()
  }

  [Service.init]() {
    this.ctx.storage.register("vector", "main", this)
  }

  async execute(operation) {
    switch (operation.type) {
      case "upsertMany": {
        const ids = []
        for (const value of operation.values) {
          this.records.set(value.id, structuredClone(value))
          ids.push(value.id)
        }
        return { ids }
      }
      case "deleteMany": {
        let affectedRows = 0
        for (const id of operation.ids) {
          if (this.records.delete(id)) affectedRows += 1
        }
        return { affectedRows }
      }
      case "search": {
        const matches = []
        for (const record of this.records.values()) {
          if (!matchesVectorFilter(record, operation.where)) continue
          matches.push({
            id: record.id,
            fields: structuredClone(record.fields),
            payload: record.payload === undefined ? undefined : structuredClone(record.payload),
            distance: cosineDistance(operation.vector, record.vector),
          })
        }
        matches.sort(
          (left, right) =>
            left.distance - right.distance || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
        )
        return { matches: matches.slice(0, operation.limit) }
      }
      default:
        throw new Error(`fake vector 不支持 ${operation.type}`)
    }
  }
}

// ---------------------------------------------------------------------------
// 编造数据：4 个 session / 8 条 Fast
// ---------------------------------------------------------------------------

const SCOPE = { userId: "bench-user", memorySpaceId: "bench-space" }

const FABRICATED = [
  {
    sessionId: "s1",
    drafts: [
      { title: "咖啡偏好", summary: "用户喜欢喝不加糖的冰美式", body: "- 用户明确表示喜欢喝不加糖的冰美式。" },
      { title: "手冲咖啡学习", summary: "用户开始学手冲咖啡并买了 V60", body: "- 用户最近开始学手冲咖啡，购买了 V60 滤杯。" },
    ],
  },
  {
    sessionId: "s2",
    drafts: [
      { title: "同事小美生日", summary: "小美下周生日，用户打算送书", body: "- 同事小美下周过生日，用户打算送她一本书当礼物。" },
      { title: "小美阅读偏好", summary: "小美喜欢科幻小说尤其三体", body: "- 小美喜欢科幻小说，尤其喜欢《三体》。" },
    ],
  },
  {
    sessionId: "s3",
    drafts: [
      { title: "跑步计划", summary: "用户决定每天跑5公里坚持一个月", body: "- 用户决定每天跑 5 公里，坚持一个月。" },
      { title: "膝盖不适", summary: "用户跑了三天后膝盖有点不舒服", body: "- 用户这周已经跑了三天，膝盖有点不舒服。" },
    ],
  },
  {
    sessionId: "s4",
    drafts: [
      { title: "季度报告截止", summary: "下周五要交项目季度报告", body: "- 下周五需要提交项目季度报告。" },
      { title: "报告内容要求", summary: "报告需包含数据分析与总结", body: "- 报告需要包含数据分析与总结。" },
    ],
  },
]

// ---------------------------------------------------------------------------
// 计时与运行
// ---------------------------------------------------------------------------

/** 包装服务方法，统计各模型调用的次数与耗时。 */
function instrument(ctx) {
  const calls = { llm: new Map(), jev: 0, embedding: 0 }
  const totals = { llm: 0, jev: 0, embedding: 0 }

  const wrap = (service, method, cat, labelFn) => {
    const original = service[method].bind(service)
    service[method] = async (...args) => {
      const label = labelFn ? labelFn(...args) : method
      const start = performance.now()
      try {
        return await original(...args)
      } finally {
        const ms = performance.now() - start
        totals[cat] += ms
        if (cat === "llm") calls.llm.set(label, (calls.llm.get(label) ?? 0) + 1)
        else calls[cat] += 1
      }
    }
  }

  wrap(ctx.llm, "generate", "llm", (options) => options.responseFormat?.name ?? "generate")
  wrap(ctx.jev, "invoke", "jev")
  wrap(ctx.embedding, "embed", "embedding")
  return { calls, totals }
}

async function main() {
  const ctx = new Context()
  const fibers = []

  const mergedSchema = {
    tables: {
      ...fastRelationalSchema.tables,
      ...longRelationalSchema.tables,
      ...feedbackRelationalSchema.tables,
      ...dailyRelationalSchema.tables,
    },
  }
  const mergedVectorSchema = {
    collections: {
      ...defineFastVectorSchema(DIM).collections,
      ...defineLongVectorSchema(DIM).collections,
    },
  }

  // 存储（内存）
  fibers.push(await ctx.plugin(ToyStorage))
  fibers.push(await ctx.plugin(RelationalStorage))
  fibers.push(await ctx.plugin(FakeRelational, { schema: mergedSchema }))
  fibers.push(await ctx.plugin(FakeVector, { schema: mergedVectorSchema }))

  // 真实模型
  fibers.push(await ctx.plugin(EmbeddingRuntime))
  fibers.push(
    await ctx.plugin(EmbeddingOpenAICompatiblePlugin, {
      provider: "dashscope",
      baseURL: process.env.DASHSCOPE_EMBEDDING_BASE_URL,
      apiKey: process.env.DASHSCOPE_API_KEY,
      dimensions: DIM,
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
  fibers.push(
    await ctx.plugin(FastMemory, {
      embeddingProvider: "dashscope",
      embeddingModel: EMBEDDING_MODEL,
      autoIndex: false,
    }),
  )
  fibers.push(await ctx.plugin(LongMemory))
  fibers.push(await ctx.plugin(MemoryFeedback))
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

  const stats = instrument(ctx)

  try {
    // 编造 Fast（纯内存写，autoIndex=false 不触发 embedding）
    let fastCount = 0
    for (const session of FABRICATED) {
      for (let i = 0; i < session.drafts.length; i += 1) {
        await ctx.memoryFast.append({
          scope: SCOPE,
          sessionId: session.sessionId,
          turnId: `${session.sessionId}-t${i + 1}`,
          drafts: [session.drafts[i]],
        })
        fastCount += 1
      }
    }

    // 计时 Daily
    const start = performance.now()
    const result = await ctx.memoryDaily.runDaily(SCOPE)
    const elapsed = performance.now() - start

    const relational = ctx.storage.get("relational", "main")
    const blocks = [...relational.rows.get("toy_memory_long_blocks").values()]

    console.log("== Daily 实测（真实模型 / 内存存储 / 并发4）==")
    console.log("Fast:", fastCount, "Session:", FABRICATED.length)
    console.log("batchId:", result.batchId)
    console.log("总耗时:", (elapsed / 1000).toFixed(2), "s")
    console.log("Long 块数:", blocks.length, blocks.map((b) => `[${b.domain}]${b.title}`).join("  "))
    console.log("-- 模型调用分解 --")
    console.log("LLM:", [...stats.calls.llm.entries()].map(([k, v]) => `${k}×${v}`).join("  "), `累计 ${(stats.totals.llm / 1000).toFixed(1)}s`)
    console.log("JEV:", stats.calls.jev, "次 累计", (stats.totals.jev / 1000).toFixed(1), "s")
    console.log("Embedding:", stats.calls.embedding, "次 累计", (stats.totals.embedding / 1000).toFixed(1), "s")
    console.log("-- 任务池 --", JSON.stringify(ctx.parallelExecutor.stats("daily").pools.daily))
  } finally {
    for (const fiber of fibers.reverse()) {
      await fiber.dispose()
    }
  }
}

await main()
