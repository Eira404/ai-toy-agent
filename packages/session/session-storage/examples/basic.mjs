/* global console, process */
import { randomUUID } from "node:crypto"
import { Context } from "cordis"
import { ToyStorage } from "toy-storage"
import { RelationalStorage } from "toy-storage-relational"
import { PostgresStorage } from "toy-storage-postgres"
import { StorageWriteQueue } from "toy-storage-write-queue"
import { SessionStorage, sessionRelationalSchema } from "../lib/index.js"

const connectionString = process.env.DATABASE_URL
if (!connectionString) {
  throw new Error("请先设置 DATABASE_URL；本包只对已连接的关系型数据库执行操作")
}

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
      schemaName: "toy_session_example",
      createMissing: true,
      schema: sessionRelationalSchema,
    }),
  )
  fibers.push(await ctx.plugin(SessionStorage, { sourceName: "main" }))

  const session = await ctx.sessionStorage.createSession({
    userId: "example-user",
    deviceId: "example-device",
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
  const receipts = await ctx.sessionStorage.appendEvents(session.sessionId, turn.turnId, events)
  console.log("Event 已入队：", receipts)
  await ctx.sessionStorage.waitForSessionWrites(session.sessionId)
  console.log(
    "已落库的 Turn 历史：",
    await ctx.sessionStorage.listTurnHistory({ sessionId: session.sessionId }),
  )
  await ctx.sessionStorage.beginClosingSession(session.sessionId)
  const closed = await ctx.sessionStorage.finishClosingSession(session.sessionId, {
    payload: { summary: "示例会话完成" },
    version: 1,
  })
  console.log("已关闭：", closed)
} finally {
  for (const fiber of fibers.reverse()) {
    await fiber.dispose()
  }
}
