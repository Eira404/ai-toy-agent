/* global console, process */
import { randomUUID } from "node:crypto"
import { Context } from "cordis"
import { RelationalStorage } from "toy-storage-relational"
import { ToyStorage } from "toy-storage"
import { PostgresStorage } from "toy-storage-postgres"

const connectionString = process.env.DATABASE_URL
if (!connectionString) {
  throw new Error("请先设置 DATABASE_URL；从仓库根目录运行时可使用 node --env-file=.env")
}

const ctx = new Context()
const storage = await ctx.plugin(ToyStorage)
const relational = await ctx.plugin(RelationalStorage)
let postgres

try {
  postgres = await ctx.plugin(PostgresStorage, {
    name: "main",
    connectionString,
    schemaName: "toy_storage_example",
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

  const database = ctx.storage.get("relational", "main")
  const sessionId = randomUUID()
  const firstId = randomUUID()
  const secondId = randomUUID()

  // 一个 turn 内的多条 Event 可以一起插入；返回顺序与输入一致。
  const written = await database.execute({
    type: "insertMany",
    table: "events",
    values: [
      { eventId: firstId, sessionId, sequence: 1, content: { role: "user", text: "你好" } },
      { eventId: secondId, sessionId, sequence: 2, content: { role: "assistant", text: "你好！" } },
    ],
  })
  console.log("写入：", written.rows)

  const one = await database.execute({ type: "get", table: "events", key: firstId })
  console.log("按 Event ID 读取：", one.row)

  const history = await database.execute({
    type: "find",
    table: "events",
    where: { type: "eq", field: "sessionId", value: sessionId },
    orderBy: [{ field: "sequence", direction: "asc" }],
    limit: 20,
  })
  console.log("按 Session ID 读取：", history.rows)

  const total = await database.execute({
    type: "count",
    table: "events",
    where: { type: "eq", field: "sessionId", value: sessionId },
  })
  console.log("当前 Session 的事件数：", total.count)

  // 多个操作需要一起提交时，使用同一个事务句柄。
  await database.transaction(async (tx) => {
    await tx.execute({
      type: "update",
      table: "events",
      where: { type: "eq", field: "eventId", value: firstId },
      patch: { content: { role: "user", text: "你好，已编辑" } },
    })
    await tx.execute({
      type: "delete",
      table: "events",
      where: { type: "eq", field: "eventId", value: secondId },
    })
  })
  console.log(
    "事务后：",
    (await database.execute({ type: "get", table: "events", key: firstId })).row,
  )
  console.log("示例数据保留在 toy_storage_example.events，sessionId：", sessionId)
} finally {
  await postgres?.dispose()
  await relational.dispose()
  await storage.dispose()
}
