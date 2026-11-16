/* global process, console */
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { Context } from "cordis"
import { Client } from "pg"
import { ToyStorage } from "toy-storage"
import { RelationalStorage } from "toy-storage-relational"
import { PostgresStorage } from "toy-storage-postgres"
import { StorageWriteQueue } from "toy-storage-write-queue"
import { SessionStorage, sessionRelationalSchema } from "../lib/index.js"

if (!process.env.DATABASE_URL) {
  throw new Error("请先设置 DATABASE_URL")
}
const schemaName = `toy_session_test_${randomUUID().replaceAll("-", "")}`
const ctx = new Context()
const fibers = []
try {
  fibers.push(await ctx.plugin(ToyStorage))
  fibers.push(await ctx.plugin(RelationalStorage))
  fibers.push(await ctx.plugin(StorageWriteQueue))
  fibers.push(
    await ctx.plugin(PostgresStorage, {
      name: "main",
      connectionString: process.env.DATABASE_URL,
      schemaName,
      createMissing: true,
      schema: sessionRelationalSchema,
    }),
  )
  fibers.push(await ctx.plugin(SessionStorage))
  const session = await ctx.sessionStorage.createSession({
    userId: "live-user",
    deviceId: "live-device",
  })
  const turn = await ctx.sessionStorage.createTurn(session.sessionId)
  const events = [
    {
      eventId: randomUUID(),
      sessionId: session.sessionId,
      turnId: turn.turnId,
      sequence: 1,
      eventType: "user_message",
      payload: { text: "你好" },
      version: 1,
      occurredAt: new Date().toISOString(),
    },
    {
      eventId: randomUUID(),
      sessionId: session.sessionId,
      turnId: turn.turnId,
      sequence: 2,
      eventType: "assistant_message",
      payload: { text: "你好！" },
      version: 1,
      occurredAt: new Date().toISOString(),
    },
  ]
  await ctx.sessionStorage.appendEvents(session.sessionId, turn.turnId, events)
  await ctx.sessionStorage.beginClosingSession(session.sessionId)
  await ctx.sessionStorage.finishClosingSession(session.sessionId, {
    payload: { summary: "结束" },
    version: 2,
  })
  const history = await ctx.sessionStorage.listTurnHistory({
    sessionId: session.sessionId,
    limit: 1,
  })
  assert.equal(history.items.length, 1)
  assert.deepEqual(
    history.items[0].events.map((event) => event.eventId),
    events.map((event) => event.eventId),
  )
  assert.equal((await ctx.sessionStorage.getSession(session.sessionId)).status, "closed")
  console.log("PostgreSQL Session/Turn/Event 集成测试通过")
} finally {
  for (const fiber of fibers.reverse()) {
    await fiber.dispose()
  }
  const client = new Client({ connectionString: process.env.DATABASE_URL })
  await client.connect()
  try {
    // schemaName 只由本测试生成且完全匹配安全标识符，删除范围限于本次隔离 Schema。
    await client.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`)
  } finally {
    await client.end()
  }
}
