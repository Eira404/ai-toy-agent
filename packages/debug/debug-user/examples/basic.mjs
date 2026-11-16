/* global console, process */
import { Context } from "cordis"
import { ToyStorage } from "toy-storage"
import { RelationalStorage } from "toy-storage-relational"
import { PostgresStorage } from "toy-storage-postgres"
import { DebugUsers, usersRelationalSchema } from "../lib/index.js"

const connectionString = process.env.DATABASE_URL
if (!connectionString) {
  throw new Error("请先设置 DATABASE_URL；本包只对已连接的关系型数据库执行操作")
}

const ctx = new Context()
const fibers = []
try {
  fibers.push(await ctx.plugin(ToyStorage))
  fibers.push(await ctx.plugin(RelationalStorage))
  fibers.push(
    await ctx.plugin(PostgresStorage, {
      name: "main",
      connectionString,
      schemaName: "toy_debug_user_example",
      createMissing: true,
      schema: usersRelationalSchema,
    }),
  )
  fibers.push(await ctx.plugin(DebugUsers, { sourceName: "main" }))

  console.log(
    await ctx.debugUsers.seedUsers([
      { userId: "debug-u1", displayName: "调试用户 1" },
      { userId: "debug-u2", note: "临时账号" },
    ]),
  )
} finally {
  for (const fiber of fibers.reverse()) {
    await fiber.dispose()
  }
}
