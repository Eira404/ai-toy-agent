/* global console, process */
import { randomUUID } from "node:crypto"
import { Context } from "cordis"
import { Client } from "pg"
import { ToyStorage } from "toy-storage"
import { RelationalStorage } from "toy-storage-relational"
import { StorageWriteQueue } from "toy-storage-write-queue"
import { PostgresStorage } from "toy-storage-postgres"
import { SessionStorage, sessionRelationalSchema } from "toy-session-storage"
import { SessionData } from "../lib/index.js"

const connectionString = process.env.DATABASE_URL
if (!connectionString) {
  throw new Error("请先在项目根目录的 .env 设置 DATABASE_URL")
}

const schemaName = "toy_session_data_example"
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
  fibers.push(await ctx.plugin(SessionStorage, { sourceName: "main" }))
  fibers.push(await ctx.plugin(SessionData))
  console.log("存储模式：", ctx.sessionData.getMode()) // persistent

  const session = await ctx.sessionData.agent.createSession({
    userId: `example-user-${randomUUID()}`,
    deviceId: "example-device",
  })
  const turn = await ctx.sessionData.agent.createTurn(session.sessionId)
  const events = await ctx.sessionData.agent.appendEvents(session.sessionId, turn.turnId, [
    { eventType: "user_message", payload: { text: "你好" } },
    { eventType: "assistant_message", payload: { text: "你好！" } },
  ])
  // appendEvents 返回表示 Event 已入队且两份内存可读，不代表数据库已经写入。
  console.log(
    "已入队、当前内存可读：",
    ctx.sessionData.agent.getTurnEvents(session.sessionId, turn.turnId),
  )
  console.log(
    "端侧读取：",
    await ctx.sessionData.read.getTurnHistory(session.sessionId, turn.turnId),
  )

  await ctx.sessionData.agent.waitForWrites(session.sessionId)
  // 用独立 PostgreSQL 客户端验证实际数据库行数，避免把缓存命中误当成落库证明。
  const client = new Client({ connectionString })
  try {
    await client.connect()
    const result = await client.query(
      `SELECT event_id FROM "${schemaName}".toy_session_events WHERE session_id = $1`,
      [session.sessionId],
    )
    console.log("数据库已确认 Event 数量：", result.rowCount, "；本次追加数量：", events.length)
  } finally {
    await client.end()
  }

  await ctx.sessionData.agent.beginClosingSession(session.sessionId)
  await ctx.sessionData.agent.finishClosingSession(session.sessionId, {
    payload: { summary: "示例结束" },
    version: 1,
  })
  console.log(
    "关闭后端侧仍可读取：",
    await ctx.sessionData.read.getTurnHistory(session.sessionId, turn.turnId),
  )
  console.log("数据库 Schema：", schemaName, "；Session ID：", session.sessionId)
} finally {
  for (const fiber of fibers.reverse()) {
    await fiber.dispose()
  }
}
