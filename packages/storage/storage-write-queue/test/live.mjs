/* global console, process */
import assert from "node:assert/strict"
import { Context } from "cordis"
import { Pool } from "pg"
import { ToyStorage } from "toy-storage"
import { RelationalStorage } from "toy-storage-relational"
import { PostgresStorage } from "toy-storage-postgres"
import { StorageWriteQueue } from "../lib/index.js"

const connectionString = process.env.DATABASE_URL
if (!connectionString) {
  throw new Error("缺少 DATABASE_URL")
}

const schemaName = `toy_queue_live_${process.pid}_${Date.now()}`
const root = new Context()
const storage = await root.plugin(ToyStorage)
const relational = await root.plugin(RelationalStorage)
const postgres = await root.plugin(PostgresStorage, {
  name: "queue-live",
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
        },
      },
    },
  },
})
const queueFiber = await root.plugin(StorageWriteQueue)
const cleanupPool = new Pool({ connectionString, connectionTimeoutMillis: 5_000 })

try {
  const receipt = root.storageWriteQueue.enqueue({
    jobId: "event:e1",
    queueName: "session-events",
    target: { kind: "relational", name: "queue-live" },
    operation: {
      type: "insert",
      table: "events",
      value: { eventId: "e1", sessionId: "s1", sequence: 1 },
    },
  })
  await root.storageWriteQueue.waitFor(receipt)
  assert.equal(root.storageWriteQueue.getStatus(receipt), "committed")
  assert.equal(root.storageWriteQueue.getStats().pending, 0)
  const database = root.storage.get("relational", "queue-live")
  const result = await database.execute({ type: "get", table: "events", key: "e1" })
  assert.equal(result.row?.sessionId, "s1")
  console.log("写入队列实库验证通过：入队、PostgreSQL 提交、出队、数据库读取")
} finally {
  await queueFiber.dispose()
  await postgres.dispose()
  await relational.dispose()
  await storage.dispose()
  await cleanupPool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`)
  await cleanupPool.end()
}
