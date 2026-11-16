/* global console, process */
import assert from "node:assert/strict"
import { Context } from "cordis"
import { Pool } from "pg"
import { RelationalStorage } from "toy-storage-relational"
import { ToyStorage } from "toy-storage"
import { PostgresStorage } from "toy-storage-postgres"

const connectionString = process.env.DATABASE_URL
if (!connectionString) {
  throw new Error("缺少 DATABASE_URL")
}

// 每次验证创建独立 schema，避免碰触应用已有表；结束后仅删除本次创建的 schema。
const schemaName = `toy_storage_live_${process.pid}_${Date.now()}`
const ctx = new Context()
const storage = await ctx.plugin(ToyStorage)
const relational = await ctx.plugin(RelationalStorage)
let postgres
const cleanupPool = new Pool({ connectionString, connectionTimeoutMillis: 5_000 })

try {
  postgres = await ctx.plugin(PostgresStorage, {
    name: "live",
    connectionString,
    schemaName,
    createMissing: true,
    schema: {
      tables: {
        events: {
          primaryKey: "eventId",
          columns: {
            eventId: { type: "string" },
            sessionId: { type: "string" },
            sequence: { type: "integer" },
            content: { type: "json" },
          },
          indexes: [{ name: "session_sequence", fields: ["sessionId", "sequence"], unique: true }],
        },
      },
    },
  })

  const database = ctx.storage.get("relational", "live")
  const inserted = await database.execute({
    type: "insertMany",
    table: "events",
    values: [
      { eventId: "e1", sessionId: "s1", sequence: 1, content: { text: "first" } },
      { eventId: "e2", sessionId: "s1", sequence: 2, content: { text: "second" } },
    ],
  })
  assert.deepEqual(
    inserted.rows.map((row) => row.eventId),
    ["e1", "e2"],
  )
  assert.deepEqual(
    (await database.execute({ type: "get", table: "events", key: "e1" })).row?.content,
    { text: "first" },
  )

  const found = await database.execute({
    type: "find",
    table: "events",
    where: { type: "eq", field: "sessionId", value: "s1" },
    orderBy: [{ field: "sequence", direction: "asc" }],
    limit: 10,
  })
  assert.deepEqual(
    found.rows.map((row) => row.sequence),
    [1, 2],
  )
  assert.equal(
    (
      await database.execute({
        type: "count",
        table: "events",
        where: { type: "eq", field: "sessionId", value: "s1" },
      })
    ).count,
    2,
  )

  const updated = await database.execute({
    type: "update",
    table: "events",
    where: { type: "eq", field: "eventId", value: "e1" },
    patch: { content: { text: "edited" } },
  })
  assert.equal(updated.affectedRows, 1)
  const upserted = await database.execute({
    type: "upsert",
    table: "events",
    value: { eventId: "e3", sessionId: "s1", sequence: 3, content: { text: "third" } },
  })
  assert.equal(upserted.inserted, true)
  const upsertedAgain = await database.execute({
    type: "upsert",
    table: "events",
    value: { eventId: "e3", sessionId: "s1", sequence: 3, content: { text: "changed" } },
  })
  assert.equal(upsertedAgain.inserted, false)

  await assert.rejects(
    () =>
      database.transaction(async (tx) => {
        await tx.execute({
          type: "delete",
          table: "events",
          where: { type: "eq", field: "eventId", value: "e1" },
        })
        throw new Error("rollback test")
      }),
    /rollback test/,
  )
  assert.ok((await database.execute({ type: "get", table: "events", key: "e1" })).row)

  const deleted = await database.execute({
    type: "delete",
    table: "events",
    where: { type: "eq", field: "eventId", value: "e2" },
  })
  assert.equal(deleted.affectedRows, 1)
  console.log("PostgreSQL 实库验证通过：建表、批量写入、读取、检索、计数、更新、upsert、回滚、删除")
} finally {
  await postgres?.dispose()
  await relational.dispose()
  await storage.dispose()
  // 名称仅由本脚本的固定前缀、进程号和时间戳组成，可以安全用于标识符。
  await cleanupPool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`)
  await cleanupPool.end()
}
