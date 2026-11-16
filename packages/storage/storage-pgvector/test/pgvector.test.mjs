/* global AbortSignal */
import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { test } from "node:test"
import { Context } from "cordis"
import { ToyStorage } from "toy-storage"
import { VectorError, VectorStorage } from "toy-storage-vector"
import { PgvectorStorage } from "../lib/index.js"
import { compileOperation } from "../lib/compiler.js"

const schema = { collections: { memories: { dimensions: 3, metric: "cosine" } } }
const write = {
  type: "upsert",
  collection: "memories",
  value: { id: "m1", vector: [1, 0, 0], fields: {} },
}

test("检索限定运算符 schema，过滤值和 Top K 使用绑定参数", () => {
  const injected = "' OR true --"
  const sql = compileOperation("App Vectors", "vector ext", ["userId", "distance"], {
    type: "search",
    collection: "memories",
    vector: [1, 0, 0],
    where: {
      type: "and",
      conditions: [
        { type: "eq", field: "userId", value: injected },
        { type: "eq", field: "distance", value: 5 },
      ],
    },
    limit: 10,
  })
  assert.match(sql.text, /FROM "App Vectors"\."memories"/)
  assert.match(sql.text, /OPERATOR\("vector ext"\.<=>\) \$1::"vector ext"\."vector"/)
  assert.match(sql.text, /"distance" AS "field_1"/)
  assert.match(sql.text, /WHERE "userId" = \$2 AND "distance" = \$3/)
  assert.match(sql.text, /\+ 0, "id" COLLATE pg_catalog\."C"/)
  assert.match(sql.text, /LIMIT \$4/)
  assert.ok(!sql.text.includes(injected))
  assert.deepEqual(sql.values, ["[1,0,0]", injected, 5, 10])
})

test("写入按 Schema 顺序绑定字段，省略 payload 时清除旧值", () => {
  const sql = compileOperation("public", "public", ["a", "b"], {
    ...write,
    value: { ...write.value, fields: { b: false, a: "first" } },
  })
  assert.match(sql.text, /ON CONFLICT \("id"\) DO UPDATE/)
  assert.match(sql.text, /"payload" = EXCLUDED\."payload"/)
  assert.deepEqual(sql.values, ["m1", "[1,0,0]", null, "first", false])
})

test("批量写入和删除分别用多行 INSERT 和绑定的 ID 数组", () => {
  const values = [write.value, { ...write.value, id: "m2", payload: { text: "记忆" } }]
  const batch = compileOperation("public", "public", [], {
    type: "upsertMany",
    collection: write.collection,
    values,
  })
  assert.match(
    batch.text,
    /VALUES \(\$1, \$2::"public"\."vector", \$3::pg_catalog\.jsonb\), \(\$4, \$5::"public"\."vector", \$6::pg_catalog\.jsonb\)/,
  )
  assert.deepEqual(batch.values, [
    "m1",
    "[1,0,0]",
    null,
    "m2",
    "[1,0,0]",
    JSON.stringify({ text: "记忆" }),
  ])
  const ids = ["m1", "' OR true --"]
  const deletion = compileOperation("public", "public", [], {
    type: "deleteMany",
    collection: write.collection,
    ids,
  })
  assert.match(
    deletion.text,
    /^DELETE FROM "public"\."memories" WHERE "id" = ANY\(\$1::pg_catalog\.text\[\]\)$/,
  )
  assert.deepEqual(deletion.values, [ids])
})

test("事务中的批量写入分块后只提交一次，回调失败则回滚", async (t) => {
  const ctx = await createContext(t)
  const { pool, calls, releases } = mockPool()
  const fiber = await ctx.plugin(PgvectorStorage, config(pool))
  t.after(() => fiber.dispose())
  const store = ctx.storage.get("vector", "main")
  const values = Array.from({ length: 1_001 }, (_, index) => ({ ...write.value, id: `m${index}` }))
  const operation = { type: "upsertMany", collection: write.collection, values }
  const start = calls.length
  const connections = releases.length
  const result = await store.transaction(async (tx) => {
    const [written, deleted] = await Promise.all([
      tx.execute(operation),
      tx.execute({ type: "deleteMany", collection: write.collection, ids: ["m0"] }),
    ])
    assert.deepEqual(deleted, { affectedRows: 1 })
    return written
  })
  assert.deepEqual(
    result.ids,
    values.map(({ id }) => id),
  )
  assert.deepEqual(
    calls.slice(start).map((sql) => sql.split(" ")[0]),
    ["BEGIN", "INSERT", "INSERT", "DELETE", "COMMIT"],
  )
  assert.equal(releases.length, connections + 1)

  const failedBatchStart = calls.length
  pool.rejectedId = values.at(-1).id
  await assert.rejects(store.execute(operation), { code: "invalid-value" })
  assert.deepEqual(
    calls.slice(failedBatchStart).map((sql) => sql.split(" ")[0]),
    ["BEGIN", "INSERT", "INSERT", "ROLLBACK"],
  )

  const failure = new Error("回调失败")
  let executor
  await assert.rejects(
    store.transaction(async (tx) => {
      executor = tx
      await tx.execute(write)
      throw failure
    }),
    (error) => error === failure,
  )
  assert.equal(calls.at(-1), "ROLLBACK")
  await assert.rejects(executor.execute(write), { code: "closed" })
})

test("扩展缺失时初始化回滚，释放池且不注册", async (t) => {
  const ctx = await createContext(t)
  const { pool, calls, releases } = mockPool({ extension: false })
  await assert.rejects(async () => ctx.plugin(PgvectorStorage, config(pool)), {
    name: "VectorError",
    code: "invalid-schema",
  })
  assert.ok(!ctx.storage.has("vector", "main"))
  assert.equal(calls.at(-1), "ROLLBACK")
  assert.deepEqual(releases, [false])
  assert.equal(pool.endCalls, 1)
})

test("提交阶段失联后返回未知状态，丢弃连接且拒绝自动重试", async (t) => {
  const ctx = await createContext(t)
  const { pool, calls, releases } = mockPool()
  const fiber = await ctx.plugin(PgvectorStorage, config(pool))
  t.after(() => fiber.dispose())
  const store = ctx.storage.get("vector", "main")
  pool.failCommit = true
  await assert.rejects(
    store.execute(write),
    (error) =>
      error instanceof VectorError &&
      error.code === "unknown-commit-state" &&
      error.unknownState &&
      !error.retryable,
  )
  assert.equal(calls.at(-1), "COMMIT")
  assert.equal(releases.at(-1), true)

  await store.close()
  await store.close()
  assert.equal(pool.endCalls, 1)
  assert.ok(!ctx.storage.has("vector", "main"))
  await assert.rejects(store.execute(write), { code: "closed" })
})

test("pgvector 拒绝单精度溢出或下溢为零的向量，取消后不获取连接", async (t) => {
  const ctx = await createContext(t)
  const { pool, calls } = mockPool()
  const fiber = await ctx.plugin(PgvectorStorage, config(pool))
  t.after(() => fiber.dispose())
  const store = ctx.storage.get("vector", "main")
  const count = calls.length
  for (const vector of [
    [1e100, 0, 0],
    [1e-100, 0, 0],
  ]) {
    await assert.rejects(store.execute({ ...write, value: { ...write.value, vector } }), {
      code: "invalid-value",
    })
  }
  await assert.rejects(store.execute(write, { signal: AbortSignal.abort() }), { code: "cancelled" })
  assert.equal(calls.length, count)
})

async function createContext(t) {
  const ctx = new Context()
  const storage = await ctx.plugin(ToyStorage)
  const vector = await ctx.plugin(VectorStorage)
  t.after(async () => {
    await vector.dispose()
    await storage.dispose()
  })
  return ctx
}

function config(pool) {
  return { pool, name: "main", connectionString: "postgresql://localhost/unit", schema }
}

function mockPool({ extension = true } = {}) {
  const calls = []
  const releases = []
  const pool = Object.assign(new EventEmitter(), { endCalls: 0, failCommit: false })
  pool.connect = async () => ({
    query: async (text, values) => {
      calls.push(text)
      if (text === "COMMIT" && pool.failCommit) {
        throw Object.assign(new Error("Connection terminated unexpectedly"), { code: "ECONNRESET" })
      }
      if (text.includes("FROM pg_catalog.pg_extension")) {
        return { rows: extension ? [{ schema: "public", typeId: "50000" }] : [] }
      }
      if (text.includes("FROM pg_catalog.pg_class")) {
        return {
          rows: [
            {
              name: "id",
              type: "text",
              typeSchema: "pg_catalog",
              required: true,
              primaryKey: true,
            },
            { name: "embedding", typeId: "50000", modifier: 3, required: true },
            { name: "payload", type: "jsonb", typeSchema: "pg_catalog", required: false },
          ],
        }
      }
      if (text.startsWith("INSERT") && values[0] === pool.rejectedId) {
        throw Object.assign(new Error("invalid input"), { code: "22000" })
      }
      const rowCount = text.startsWith("INSERT") ? values.length / 3 : 1
      return { command: text, rows: [], rowCount }
    },
    release: (discard) => releases.push(discard),
  })
  pool.end = async () => {
    pool.endCalls += 1
  }
  return { pool, calls, releases }
}
