import assert from "node:assert/strict"
import test from "node:test"
import { Context } from "cordis"
import { RelationalError, RelationalStorage } from "toy-storage-relational"
import { ToyStorage } from "toy-storage"
import { PostgresRelationalAdapter } from "../lib/adapter.js"
import { compileOperation } from "../lib/compiler.js"
import { PostgresStorage } from "../lib/index.js"

const ctx = new Context()
await ctx.plugin(RelationalStorage)
const schema = ctx.storageRelational.defineSchema({
  tables: {
    events: {
      primaryKey: "eventId",
      columns: {
        eventId: { type: "string" },
        sessionId: { type: "string" },
        sequence: { type: "integer" },
        payload: { type: "json", nullable: true },
      },
      indexes: [{ name: "session_sequence", fields: ["sessionId", "sequence"], unique: true }],
    },
  },
})

function fakePool(onQuery) {
  const queries = []
  const releases = []
  const client = {
    async query(text, values = []) {
      queries.push({ text, values })
      return onQuery?.(text, values) ?? { rows: [], rowCount: 0 }
    },
    release(value) {
      releases.push(value)
    },
  }
  return {
    queries,
    releases,
    on() {
      return this
    },
    async connect() {
      return client
    },
    async end() {
      return undefined
    },
  }
}

function createAdapter(pool, createMissing = false) {
  return new PostgresRelationalAdapter(
    { name: "main", connectionString: "postgres://unused", schema, createMissing },
    schema,
    (operation) => ctx.storageRelational.assertOperation(schema, operation),
    pool,
  )
}

test("SQL 编译将值参数化，并限定 schema 和表名", () => {
  const compiled = compileOperation(schema, "public", {
    type: "find",
    table: "events",
    where: { type: "eq", field: "sessionId", value: "x' OR TRUE --" },
    orderBy: [{ field: "sequence", direction: "asc" }],
    limit: 5,
  })
  assert.match(compiled.text, /^SELECT \* FROM "public"\."events" WHERE "sessionId" = \$1/)
  assert.match(compiled.text, /ORDER BY "sequence" ASC, "eventId" ASC LIMIT \$2$/)
  assert.deepEqual(compiled.values, ["x' OR TRUE --", 5])
})

test("in 与 notIn 对 null 使用明确的集合语义", () => {
  const where = { type: "notIn", field: "payload", values: [null, { x: 1 }] }
  const compiled = compileOperation(schema, "public", { type: "count", table: "events", where })
  assert.match(compiled.text, /"payload" IS NOT NULL AND "payload" NOT IN \(\$1::jsonb\)/)
  assert.deepEqual(compiled.values, [`{"x":1}`])
})

test("事务使用同一个 client，成功提交并返回规范化结果", async () => {
  const pool = fakePool((sql) => {
    if (sql.startsWith("SELECT *")) {
      return {
        rows: [
          {
            eventId: "e1",
            sessionId: "s1",
            sequence: "42",
            payload: { message: "hi" },
          },
        ],
        rowCount: 1,
      }
    }
    return { rows: [], rowCount: 0 }
  })
  const adapter = createAdapter(pool)
  await adapter.initialize()
  const result = await adapter.execute({ type: "get", table: "events", key: "e1" })
  assert.deepEqual(
    { ...result.row },
    {
      eventId: "e1",
      sessionId: "s1",
      sequence: 42,
      payload: { message: "hi" },
    },
  )
  assert.deepEqual(
    pool.queries.map((query) => query.text),
    ["SELECT 1", "BEGIN", `SELECT * FROM "public"."events" WHERE "eventId" = $1 LIMIT 1`, "COMMIT"],
  )
  await adapter.close()
})

test("COMMIT 失败返回未知提交状态，禁止盲目重试", async () => {
  const pool = fakePool((sql) => {
    if (sql === "COMMIT") {
      throw new Error("connection lost")
    }
    return { rows: [], rowCount: 0 }
  })
  const adapter = createAdapter(pool)
  await assert.rejects(
    () =>
      adapter.execute({
        type: "delete",
        table: "events",
        where: { type: "eq", field: "eventId", value: "e1" },
      }),
    (error) => error instanceof RelationalError && error.code === "unknown-commit-state",
  )
  assert.equal(
    pool.queries.some((query) => query.text === "ROLLBACK"),
    false,
  )
  assert.equal(pool.releases.at(-1), true)
  await adapter.close()
})

test("业务回调异常原样抛出并回滚，事务句柄随后失效", async () => {
  const pool = fakePool()
  const adapter = createAdapter(pool)
  const failure = new Error("业务校验未通过")
  let savedExecutor
  await assert.rejects(
    () =>
      adapter.transaction(async (executor) => {
        savedExecutor = executor
        throw failure
      }),
    (error) => error === failure,
  )
  assert.equal(pool.queries.at(-1).text, "ROLLBACK")
  await assert.rejects(
    () => savedExecutor.execute({ type: "get", table: "events", key: "e1" }),
    (error) => error instanceof RelationalError && error.code === "closed",
  )
  await adapter.close()
})

test("CRUD 的写入使用参数并保留明确的 upsert 返回路径", () => {
  const insert = compileOperation(schema, "public", {
    type: "insertMany",
    table: "events",
    values: [
      { eventId: "e1", sessionId: "s1", sequence: 1, payload: { text: "hello" } },
      { eventId: "e2", sessionId: "s1", sequence: 2, payload: { text: "world" } },
    ],
  })
  assert.match(
    insert.text,
    /INSERT INTO "public"\."events" .* VALUES \(\$1, \$2, \$3, \$4::jsonb\), \(\$5, \$6, \$7, \$8::jsonb\) RETURNING \*/,
  )
  assert.equal(insert.values[3], `{"text":"hello"}`)

  const upsert = compileOperation(schema, "public", {
    type: "upsert",
    table: "events",
    value: { eventId: "e1" },
  })
  assert.match(
    upsert.text,
    /ON CONFLICT \("eventId"\) DO UPDATE SET "eventId" = EXCLUDED\."eventId" RETURNING/,
  )
})

test("insertMany 按输入主键恢复结果顺序", async () => {
  const pool = fakePool((sql) => {
    if (sql.startsWith("INSERT INTO")) {
      return {
        rows: [
          { eventId: "e2", sessionId: "s1", sequence: "2", payload: null },
          { eventId: "e1", sessionId: "s1", sequence: "1", payload: null },
        ],
        rowCount: 2,
      }
    }
    return { rows: [], rowCount: 0 }
  })
  const adapter = createAdapter(pool)
  const result = await adapter.execute({
    type: "insertMany",
    table: "events",
    values: [
      { eventId: "e1", sessionId: "s1", sequence: 1, payload: null },
      { eventId: "e2", sessionId: "s1", sequence: 2, payload: null },
    ],
  })
  assert.deepEqual(
    result.rows.map((row) => row.eventId),
    ["e1", "e2"],
  )
  assert.equal(pool.queries.filter((query) => query.text.startsWith("INSERT INTO")).length, 1)
  await adapter.close()
})

test("数据库生成主键时逐条插入并保持结果顺序", async () => {
  const generatedSchema = ctx.storageRelational.defineSchema({
    tables: {
      items: {
        primaryKey: "id",
        columns: { id: { type: "integer", generated: true }, name: { type: "string" } },
      },
    },
  })
  let nextId = 0
  const pool = fakePool((sql, values) => {
    if (sql.startsWith("INSERT INTO")) {
      return { rows: [{ id: String(++nextId), name: values[0] }], rowCount: 1 }
    }
    return { rows: [], rowCount: 0 }
  })
  const adapter = new PostgresRelationalAdapter(
    { name: "main", connectionString: "postgres://unused", schema: generatedSchema },
    generatedSchema,
    (operation) => ctx.storageRelational.assertOperation(generatedSchema, operation),
    pool,
  )
  const result = await adapter.execute({
    type: "insertMany",
    table: "items",
    values: [{ name: "first" }, { name: "second" }],
  })
  assert.deepEqual(
    result.rows.map((row) => [row.id, row.name]),
    [
      [1, "first"],
      [2, "second"],
    ],
  )
  assert.equal(pool.queries.filter((query) => query.text.startsWith("INSERT INTO")).length, 2)
  await adapter.close()
})

test("createMissing 只创建缺失结构和唯一索引", async () => {
  const pool = fakePool()
  const adapter = createAdapter(pool, true)
  await adapter.initialize()
  assert.equal(pool.queries[0].text, "BEGIN")
  assert.match(pool.queries[2].text, /CREATE TABLE IF NOT EXISTS "public"\."events"/)
  assert.match(pool.queries[3].text, /CREATE UNIQUE INDEX IF NOT EXISTS "events_session_sequence"/)
  assert.equal(pool.queries.at(-1).text, "COMMIT")
  await adapter.close()
})

test("Cordis 类插件在就绪后注册命名实例，卸载时撤销", async () => {
  const root = new Context()
  const storageFiber = await root.plugin(ToyStorage)
  const relationalFiber = await root.plugin(RelationalStorage)
  const pool = fakePool()
  const postgresFiber = await root.plugin(PostgresStorage, {
    name: "main",
    connectionString: "postgres://unused",
    schema,
    pool,
  })
  const database = root.storage.get("relational", "main")
  assert.equal(database.schema, schema)
  assert.equal(database.capabilities.transactions, true)
  await postgresFiber.dispose()
  assert.equal(root.storage.tryGet("relational", "main"), undefined)
  await relationalFiber.dispose()
  await storageFiber.dispose()
})
