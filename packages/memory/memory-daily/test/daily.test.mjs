/* global structuredClone */
import assert from "node:assert/strict"
import test from "node:test"
import { Context, Service } from "cordis"
import { ToyStorage } from "toy-storage"
import { RelationalStorage } from "toy-storage-relational"
import { EmbeddingRuntime } from "toy-embedding"
import { FastMemory, fastRelationalSchema, defineFastVectorSchema } from "toy-memory-fast"
import { LongMemory, longRelationalSchema, defineLongVectorSchema } from "toy-memory-long"
import { MemoryFeedback, feedbackRelationalSchema } from "toy-memory-feedback"
import { ParallelExecutor } from "toy-parallel-executor"
import { MemoryDaily, dailyRelationalSchema } from "../lib/index.js"

const DIM = 4

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

// ---------------------------------------------------------------------------
// 内存 fake：关系型、向量、LLM、JEV、Embedding
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
    if (!index.unique) {
      continue
    }
    const key = index.fields.map((field) => row[field]).join("\u0000")
    if (key === ignoredKey) {
      continue
    }
    for (const [existingKey, existing] of table) {
      const existingIndexKey = index.fields.map((field) => existing[field]).join("\u0000")
      if (existingIndexKey === key) {
        return true
      }
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
          if (operation.where !== undefined && !matches(row, operation.where)) {
            continue
          }
          Object.assign(row, structuredClone(operation.patch))
          affectedRows += 1
        }
        return { affectedRows }
      }
      case "delete": {
        let affectedRows = 0
        for (const [key, row] of [...table]) {
          if (operation.where !== undefined && !matches(row, operation.where)) {
            continue
          }
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
  if (leftNorm === 0 || rightNorm === 0) {
    return 1
  }
  return 1 - dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm))
}

function matchesVectorFilter(record, filter) {
  if (filter === undefined) {
    return true
  }
  if (filter.type === "eq") {
    return record.fields[filter.field] === filter.value
  }
  if (filter.type === "and") {
    return filter.conditions.every((condition) => matchesVectorFilter(record, condition))
  }
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
          if (this.records.delete(id)) {
            affectedRows += 1
          }
        }
        return { affectedRows }
      }
      case "search": {
        const matches = []
        for (const record of this.records.values()) {
          if (!matchesVectorFilter(record, operation.where)) {
            continue
          }
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

/** 提供 ctx.llm 的伪服务：按 responseFormat.name 返回对应阶段的结构化输出。 */
class FakeLlm extends Service {
  constructor(ctx) {
    super(ctx, "llm")
    this.calls = []
  }

  async generate(options) {
    this.calls.push(options)
    const name = options.responseFormat?.name ?? ""
    return {
      content: [{ type: "text", text: JSON.stringify(llmResponse(name, options)) }],
      finish: { kind: "stop" },
    }
  }
}

function llmResponse(name, options) {
  switch (name) {
    case "session_consolidation":
    case "cross_consolidation":
      return { memories: [{ title: "咖啡偏好", summary: "用户喜欢喝冰美式", body: "- 用户喜欢喝冰美式。" }] }
    case "cross_grouping": {
      const text = options.messages
        .map((m) => m.content.map((b) => (b.type === "text" ? b.text : "")).join(""))
        .join("\n")
      const ids = [...text.matchAll(/CandidateId:(\S+)/g)].map((m) => m[1])
      return { groups: [{ candidateIds: ids }] }
    }
    case "block_generation":
      return {
        title: "咖啡偏好",
        aliases: [],
        summary: "用户喜欢喝冰美式",
        overviewBody: "用户喜欢喝冰美式。",
        detailOperations: [],
      }
    case "verify":
      return { verdict: "PASS" }
    default:
      return { memories: [] }
  }
}

/** 提供 ctx.jev 的伪服务：domain 返回 self，其余返回第一个判据。 */
class FakeJev extends Service {
  constructor(ctx) {
    super(ctx, "jev")
  }

  async invoke(_state, questions, _options) {
    const answers = {}
    for (const [key, question] of Object.entries(questions)) {
      const choice = key === "domain" ? "self" : (Object.keys(question.criteria ?? {})[0] ?? "")
      answers[key] = { type: "choice", choice, confidence: 1, probabilities: { [choice]: 1 } }
    }
    return { answers, model: "fake-jev" }
  }
}

const fakeEmbeddingAdapter = {
  providerInfo: (id) => ({ id, name: "fake" }),
  embed: async (request) => ({
    vectors: request.texts.map(() => new Array(DIM).fill(1)),
    modelId: "fake-model",
    dimensions: DIM,
  }),
}

// ---------------------------------------------------------------------------
// setup + 测试
// ---------------------------------------------------------------------------

async function setup() {
  const ctx = new Context()
  const fibers = []
  fibers.push(await ctx.plugin(ToyStorage))
  fibers.push(await ctx.plugin(RelationalStorage))
  fibers.push(await ctx.plugin(FakeRelational, { schema: mergedSchema }))
  fibers.push(await ctx.plugin(FakeVector, { schema: mergedVectorSchema }))
  fibers.push(await ctx.plugin(EmbeddingRuntime))
  const unregisterEmbedding = ctx.embedding.registerAdapter("fake", fakeEmbeddingAdapter)
  fibers.push(await ctx.plugin(FakeLlm))
  fibers.push(await ctx.plugin(FakeJev))
  fibers.push(
    await ctx.plugin(FastMemory, {
      embeddingProvider: "fake",
      embeddingModel: "fake-model",
      autoIndex: false,
    }),
  )
  fibers.push(await ctx.plugin(LongMemory))
  fibers.push(await ctx.plugin(MemoryFeedback))
  fibers.push(await ctx.plugin(ParallelExecutor))
  fibers.push(
    await ctx.plugin(MemoryDaily, {
      llmProvider: "fake",
      llmModel: "fake-model",
      jevProvider: "fake",
      embeddingProvider: "fake",
      embeddingModel: "fake-model",
    }),
  )

  return {
    ctx,
    database: ctx.storage.get("relational", "main"),
    async dispose() {
      unregisterEmbedding()
      for (const fiber of fibers.reverse()) {
        await fiber.dispose()
      }
    },
  }
}

test("空数据跑通 Daily 全链路：批次成功 + 空间状态计数 +1", async () => {
  const app = await setup()
  try {
    const result = await app.ctx.memoryDaily.runDaily({ userId: "u1", memorySpaceId: "m1" })

    const batchRow = app.database.rows.get("toy_memory_daily_batches").get(result.batchId)
    assert.equal(batchRow.status, "succeeded")
    assert.equal(batchRow.checkpoint_stage, 9)

    const spaceRow = app.database.rows.get("toy_memory_daily_space_state").get("m1")
    assert.equal(spaceRow.successful_daily_count, 1)
    assert.ok(spaceRow.last_daily_at)

    // 每个阶段都写了 checkpoint（0~8 共 9 个）
    const checkpoints = app.database.rows.get("toy_memory_daily_checkpoints")
    assert.equal(checkpoints.size, 9)
  } finally {
    await app.dispose()
  }
})

test("单条 Fast 跑通：生成一个 Long 块并消费 Fast", async () => {
  const app = await setup()
  try {
    await app.ctx.memoryFast.append({
      scope: { userId: "u1", memorySpaceId: "m1" },
      sessionId: "s1",
      turnId: "t1",
      drafts: [{ title: "咖啡偏好", summary: "用户喜欢喝冰美式", body: "- 用户喜欢喝冰美式。" }],
    })

    await app.ctx.memoryDaily.runDaily({ userId: "u1", memorySpaceId: "m1" })

    const blocks = [...app.database.rows.get("toy_memory_long_blocks").values()]
    assert.equal(blocks.length, 1)
    assert.equal(blocks[0].title, "咖啡偏好")
    assert.equal(blocks[0].lifecycle_status, "active")
    assert.equal(blocks[0].value_version, "none") // 无价值引擎 → NO_VALUE_STATE

    const fastRows = [...app.database.rows.get("toy_memory_fast_records").values()]
    assert.equal(fastRows.length, 1)
    assert.ok(fastRows[0].consumed_batch_id)
  } finally {
    await app.dispose()
  }
})

test("多个 Session 并行整合：每个 Session 都产出一条候选并全部消费", async () => {
  const app = await setup()
  try {
    const scope = { userId: "u1", memorySpaceId: "m1" }
    const sessionIds = ["s1", "s2", "s3"]
    for (const [index, sessionId] of sessionIds.entries()) {
      await app.ctx.memoryFast.append({
        scope,
        sessionId,
        turnId: `t${index + 1}`,
        drafts: [{ title: "咖啡偏好", summary: "用户喜欢喝冰美式", body: "- 用户喜欢喝冰美式。" }],
      })
    }

    await app.ctx.memoryDaily.runDaily(scope)

    // 每个 Session 独立走一次阶段一 LLM 整合（无丢弃）
    const sessionCalls = app.ctx.llm.calls.filter(
      (call) => call.responseFormat?.name === "session_consolidation",
    )
    assert.equal(sessionCalls.length, 3)

    const fastRows = [...app.database.rows.get("toy_memory_fast_records").values()]
    assert.equal(fastRows.length, 3)
    assert.ok(fastRows.every((row) => row.consumed_batch_id))
  } finally {
    await app.dispose()
  }
})

test("注册 Gate 后 runDaily 会先 acquire、结束后 release，凭证写入批次", async () => {
  const app = await setup()
  try {
    const calls = []
    const unregisterGate = app.ctx.memoryDaily.registerGate({
      async acquire(scope) {
        calls.push(["acquire", scope.memorySpaceId])
        return "cred-1"
      },
      async release(scope, credential) {
        calls.push(["release", scope.memorySpaceId, credential])
      },
    })
    try {
      const result = await app.ctx.memoryDaily.runDaily({ userId: "u1", memorySpaceId: "m1" })
      assert.deepEqual(calls, [
        ["acquire", "m1"],
        ["release", "m1", "cred-1"],
      ])
      const batchRow = app.database.rows.get("toy_memory_daily_batches").get(result.batchId)
      assert.equal(batchRow.gate_credential, "cred-1")
    } finally {
      unregisterGate()
    }
  } finally {
    await app.dispose()
  }
})
