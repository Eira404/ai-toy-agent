/* global console, process */
import { Context } from "cordis"
import { ToyStorage } from "toy-storage"
import { RelationalStorage } from "toy-storage-relational"
import { PostgresStorage } from "toy-storage-postgres"
import { DebugDevices, devicesRelationalSchema } from "toy-debug-device"
import { DeviceService } from "../lib/index.js"

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
      schemaName: "toy_device_example",
      createMissing: true,
      schema: devicesRelationalSchema,
    }),
  )
  fibers.push(await ctx.plugin(DebugDevices, { sourceName: "main" }))
  fibers.push(await ctx.plugin(DeviceService))

  await ctx.debugDevices.seedDevices([
    { deviceId: "device-d1", userId: "u1", displayName: "娃娃 1", persona: "小恐龙", age: 5 },
    { deviceId: "device-d2", userId: "u1", displayName: "娃娃 2", persona: "小兔子", age: 11 },
    { deviceId: "device-d3", userId: "u1", displayName: "娃娃 3" },
  ])
  console.log("d1 预设：", await ctx.device.getDevicePresets("device-d1"))
  console.log("d2 预设：", await ctx.device.getDevicePresets("device-d2"))
  console.log("d3 预设：", await ctx.device.getDevicePresets("device-d3"))
} finally {
  for (const fiber of fibers.reverse()) {
    await fiber.dispose()
  }
}
