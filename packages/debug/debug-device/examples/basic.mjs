/* global console, process */
import { Context } from "cordis"
import { ToyStorage } from "toy-storage"
import { RelationalStorage } from "toy-storage-relational"
import { PostgresStorage } from "toy-storage-postgres"
import { DebugDevices, devicesRelationalSchema } from "../lib/index.js"

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
      schemaName: "toy_debug_device_example",
      createMissing: true,
      schema: devicesRelationalSchema,
    }),
  )
  fibers.push(await ctx.plugin(DebugDevices, { sourceName: "main" }))

  console.log(
    await ctx.debugDevices.seedDevices([
      { deviceId: "debug-d1", userId: "u1", displayName: "娃娃 1", persona: "小恐龙", age: 5 },
      { deviceId: "debug-d2", userId: "u1", displayName: "娃娃 2", persona: "小兔子", age: 8 },
    ]),
  )
  console.log("u1 的设备：", await ctx.debugDevices.listDevices({ userId: "u1" }))
} finally {
  for (const fiber of fibers.reverse()) {
    await fiber.dispose()
  }
}
