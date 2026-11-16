/* global console, process */
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { Context } from "cordis"
import { Client } from "pg"
import { ToyStorage } from "toy-storage"
import { RelationalStorage } from "toy-storage-relational"
import { StorageWriteQueue } from "toy-storage-write-queue"
import { PostgresStorage } from "toy-storage-postgres"
import { SessionStorage, sessionRelationalSchema } from "toy-session-storage"
import { SessionData, SessionDataError } from "../lib/index.js"

const connectionString = process.env.DATABASE_URL
if (!connectionString) {
  throw new Error("请先设置 DATABASE_URL")
}
const schemaName = `toy_session_data_test_${randomUUID().replaceAll("-", "")}`
const ctx = new Context()
const fibers = []
try {
  fibers.push(await ctx.plugin(ToyStorage))
  fibers.push(await ctx.plugin(RelationalStorage))
  fibers.push(await ctx.plugin(StorageWriteQueue))
  fibers.push(
    await ctx.plugin(PostgresStorage, {
      name: "main",
      connectionString,
      schemaName,
      createMissing: true,
      schema: sessionRelationalSchema,
    }),
  )
  fibers.push(await ctx.plugin(SessionStorage))
  fibers.push(await ctx.plugin(SessionData, { maxReadSessions: 1, maxReadPages: 1 }))
  assert.equal(ctx.sessionData.getMode(), "persistent")

  const first = await ctx.sessionData.agent.createSession({
    userId: "live-user",
    deviceId: "live-device",
  })
  const turn = await ctx.sessionData.agent.createTurn(first.sessionId)
  const events = await ctx.sessionData.agent.appendEvents(first.sessionId, turn.turnId, [
    { eventType: "user", payload: { text: "你好" } },
    { eventType: "assistant", payload: { text: "你好！" } },
  ])
  assert.deepEqual(ctx.sessionData.agent.getTurnEvents(first.sessionId, turn.turnId), events)
  assert.equal(
    (await ctx.sessionData.read.getTurnHistory(first.sessionId, turn.turnId)).events.length,
    2,
  )
  await ctx.sessionData.agent.beginClosingSession(first.sessionId)
  await ctx.sessionData.agent.finishClosingSession(first.sessionId, {
    payload: { summary: "完成" },
    version: 2,
  })
  await assert.rejects(
    async () => ctx.sessionData.agent.getHistory(first.sessionId),
    (error) => error instanceof SessionDataError && error.code === "not-resident",
  )
  const second = await ctx.sessionData.agent.createSession({
    userId: "live-user",
    deviceId: "live-device",
  })
  assert.notEqual(second.sessionId, first.sessionId)
  // 读取缓存上限为 1，旧 Session 可从关系型存储按 Turn 精确补读。
  const restored = await ctx.sessionData.read.getTurnHistory(first.sessionId, turn.turnId)
  assert.deepEqual(
    restored.events.map((event) => event.eventId),
    events.map((event) => event.eventId),
  )
  const page = await ctx.sessionData.read.listTurnHistory({ sessionId: first.sessionId, limit: 1 })
  assert.equal(page.items[0].events.length, 2)
  const secondTurn = await ctx.sessionData.agent.createTurn(second.sessionId)
  await ctx.sessionData.agent.appendEvents(second.sessionId, secondTurn.turnId, [
    { eventType: "user", payload: { text: "恢复后继续" } },
  ])
  await ctx.sessionData.agent.waitForWrites(second.sessionId)
  const oldDataFiber = fibers.pop()
  await oldDataFiber.dispose()
  fibers.push(await ctx.plugin(SessionData, { maxReadSessions: 1, maxReadPages: 1 }))
  assert.equal(ctx.sessionData.agent.getSession(second.sessionId), undefined)
  const resumed = await ctx.sessionData.agent.restoreSession(second.sessionId)
  assert.equal(resumed.turns[0].events[0].turnId, secondTurn.turnId)
  console.log("PostgreSQL SessionData 双内存与持久化集成测试通过")
} finally {
  for (const fiber of fibers.reverse()) {
    await fiber.dispose()
  }
  const client = new Client({ connectionString })
  await client.connect()
  try {
    // schemaName 仅由本次测试生成，删除范围限于独立测试 Schema。
    await client.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`)
  } finally {
    await client.end()
  }
}
