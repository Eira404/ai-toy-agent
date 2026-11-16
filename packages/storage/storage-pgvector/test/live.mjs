/* global process */
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { test } from "node:test"
import { Context } from "cordis"
import { Pool } from "pg"
import { ToyStorage } from "toy-storage"
import { PgvectorStorage } from "toy-storage-pgvector"
import { VectorStorage } from "toy-storage-vector"
import { StorageWriteQueue } from "toy-storage-write-queue"

const connectionString = process.env.DATABASE_URL
if (!connectionString) {
  throw new Error("缺少 DATABASE_URL")
}

const schema = {
  collections: {
    memories: {
      dimensions: 3,
      metric: "cosine",
      filterFields: { userId: "string", category: "string", rank: "number", active: "boolean" },
    },
  },
}
const collection = "memories"
const search = {
  type: "search",
  collection,
  vector: [1, 0, 0],
  where: {
    type: "and",
    conditions: [
      { type: "eq", field: "userId", value: "u1" },
      { type: "eq", field: "category", value: "preference" },
      { type: "eq", field: "active", value: true },
    ],
  },
  limit: 3,
}

test("Docker PostgreSQL 上的 pgvector 存储", async (t) => {
  // 只在本次运行独有的 schema 中创建表，测试结束后清理。
  const schemaName = `toy_pgvector_live_${randomUUID().replaceAll("-", "")}`
  const pool = new Pool({ connectionString, connectionTimeoutMillis: 5_000 })
  const ctx = new Context()
  const fibers = []
  t.after(async () => {
    try {
      for (const fiber of fibers.reverse()) {
        await fiber.dispose()
      }
    } finally {
      try {
        await pool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`)
      } finally {
        await pool.end()
      }
    }
  })
  fibers.push(await ctx.plugin(ToyStorage))
  fibers.push(await ctx.plugin(VectorStorage))

  const config = { name: "main", connectionString, schemaName, schema, maxConnections: 1 }
  await t.test("默认验证缺失表并拒绝注册，显式配置后建表", async () => {
    await assert.rejects(async () => ctx.plugin(PgvectorStorage, config), {
      code: "collection-not-found",
    })
    assert.ok(!ctx.storage.has("vector", "main"))
    fibers.push(await ctx.plugin(PgvectorStorage, { ...config, createMissing: true }))
    assert.ok(ctx.storage.has("vector", "main"))
  })
  const store = ctx.storage.get("vector", "main")

  await t.test("写入、读取、整体替换、清除 payload 和重复删除", async () => {
    const first = record("replace", [1, 0, 0])
    assert.deepEqual(await store.execute(upsert(first)), { id: first.id })
    assert.deepEqual(await store.execute({ type: "get", collection, id: first.id }), {
      record: first,
    })
    const replacement = {
      id: first.id,
      vector: [0, 1, 0],
      fields: { userId: "u2", category: "updated", rank: 0, active: false },
    }
    await store.execute(upsert(replacement))
    assert.deepEqual(await store.execute({ type: "get", collection, id: first.id }), {
      record: replacement,
    })
    const deletion = { type: "delete", collection, id: first.id }
    assert.deepEqual(await store.execute(deletion), { affectedRows: 1 })
    assert.deepEqual(await store.execute(deletion), { affectedRows: 0 })
    assert.deepEqual(await store.execute({ type: "get", collection, id: first.id }), {
      record: undefined,
    })
  })

  await t.test("批量写入、删除与向量事务回滚", async () => {
    const first = record("batch-first", [1, 0, 0])
    const second = record("batch-second", [0, 1, 0])
    const write = { type: "upsertMany", collection, values: [first, second] }
    const getFirst = { type: "get", collection, id: first.id }
    const deletion = {
      type: "deleteMany",
      collection,
      ids: [first.id, second.id, first.id, "missing"],
    }

    await assert.rejects(
      store.transaction(async (tx) => {
        assert.deepEqual(await tx.execute(write), { ids: [first.id, second.id] })
        assert.deepEqual(await tx.execute(getFirst), { record: first })
        throw new Error("回滚批量写入")
      }),
      { message: "回滚批量写入" },
    )
    assert.deepEqual(await store.execute(getFirst), { record: undefined })
    assert.deepEqual(await store.execute(write), { ids: [first.id, second.id] })
    assert.deepEqual(await store.execute(deletion), { affectedRows: 2 })
    assert.deepEqual(await store.execute(deletion), { affectedRows: 0 })
  })

  await t.test("多条件先过滤，余弦距离排序，同距离按 ID 排序", async () => {
    for (const value of [
      record("b", [1, 0, 0]),
      record("a", [1, 0, 0]),
      record("c", [1, 1, 0]),
      record("d", [0, 1, 0]),
      record("0-other-user", [1, 0, 0], { userId: "u2" }),
      record("0-other-category", [1, 0, 0], { category: "other" }),
      record("0-inactive", [1, 0, 0], { active: false }),
    ]) {
      await store.execute(upsert(value))
    }
    const { matches } = await store.execute(search)
    assert.deepEqual(
      matches.map(({ id }) => id),
      ["a", "b", "c"],
    )
    assert.deepEqual(
      matches.slice(0, 2).map(({ distance }) => distance),
      [0, 0],
    )
    assert.ok(Math.abs(matches[2].distance - (1 - 1 / Math.sqrt(2))) < 1e-6)
    assert.deepEqual(matches[0].payload, { text: "a" })
    assert.ok(!Object.hasOwn(matches[0], "vector"))

    const singleFilter = { type: "eq", field: "category", value: "other" }
    assert.deepEqual(
      (await store.execute({ ...search, where: singleFilter })).matches.map(({ id }) => id),
      ["0-other-category"],
    )
  })

  await t.test("维度不符时回滚本次创建的表，并可重新挂载兼容的 Schema", async () => {
    const incompatible = {
      collections: {
        scratch: { dimensions: 3, metric: "cosine" },
        memories: { ...schema.collections.memories, dimensions: 2 },
      },
    }
    await assert.rejects(
      async () =>
        ctx.plugin(PgvectorStorage, {
          ...config,
          name: "bad",
          createMissing: true,
          schema: incompatible,
        }),
      { code: "invalid-schema" },
    )
    assert.ok(!ctx.storage.has("vector", "bad"))
    const result = await pool.query("SELECT to_regclass($1) AS scratch", [`${schemaName}.scratch`])
    assert.equal(result.rows[0].scratch, null)
    fibers.push(await ctx.plugin(PgvectorStorage, { ...config, name: "reopen" }))
    const reopened = ctx.storage.get("vector", "reopen")
    assert.deepEqual(await reopened.execute({ type: "get", collection, id: "a" }), {
      record: record("a", [1, 0, 0]),
    })
  })

  await t.test("被锁阻塞的检索超时后回滚，连接池可继续执行", async () => {
    const locker = await pool.connect()
    try {
      await locker.query("BEGIN")
      await locker.query(`LOCK TABLE "${schemaName}"."memories" IN ACCESS EXCLUSIVE MODE`)
      await assert.rejects(store.execute(search, { timeoutMs: 50 }), {
        code: "timeout",
        retryable: true,
      })
    } finally {
      try {
        await locker.query("ROLLBACK")
      } finally {
        locker.release()
      }
    }
    assert.equal((await store.execute(search)).matches[0].id, "a")
  })

  await t.test("写队列按 vector/main 路由，提交后可读取并能卸载实例", async () => {
    fibers.push(await ctx.plugin(StorageWriteQueue))
    const queued = record("queued", [1, 0, 0])
    const receipt = ctx.storageWriteQueue.enqueue({
      jobId: queued.id,
      queueName: "embeddings",
      target: { kind: "vector", name: "main" },
      operation: upsert(queued),
    })
    await ctx.storageWriteQueue.waitFor(receipt, { timeoutMs: 3_000 })
    assert.deepEqual(await store.execute({ type: "get", collection, id: queued.id }), {
      record: queued,
    })
    await store.close()
    assert.ok(!ctx.storage.has("vector", "main"))
  })
})

function upsert(value) {
  return { type: "upsert", collection, value }
}

function record(id, vector, fields = {}) {
  return {
    id,
    vector,
    fields: { userId: "u1", category: "preference", rank: 1.5, active: true, ...fields },
    payload: { text: id },
  }
}
