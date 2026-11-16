// toy-memory-space 基本用法演示（内存 mock，不连真库）。
import { Context } from "cordis"
import { ToyStorage } from "toy-storage"
import { MemorySpaceService, spaceRelationalSchema } from "../lib/index.js"
import { FakeRelational } from "../test/helpers.mjs"

const ctx = new Context()
const fibers = []
fibers.push(await ctx.plugin(ToyStorage))
fibers.push(await ctx.plugin(FakeRelational, { schema: spaceRelationalSchema }))
fibers.push(await ctx.plugin(MemorySpaceService))

try {
  const space = await ctx.memorySpace.createSpace({ userId: "u1", name: "家庭" })
  await ctx.memorySpace.bindDevice({ userId: "u1", deviceId: "d1", memorySpaceId: space.memorySpaceId })
  await ctx.memorySpace.bindDevice({ userId: "u1", deviceId: "d2", memorySpaceId: space.memorySpaceId })

  console.log("空间：", await ctx.memorySpace.getSpace(space.memorySpaceId))
  console.log("娃娃：", await ctx.memorySpace.listBoundDevices(space.memorySpaceId))
  console.log("d1 解析：", await ctx.memorySpace.resolveMemorySpace("u1", "d1"))
  console.log("d3 解析：", await ctx.memorySpace.resolveMemorySpace("u1", "d3"))

  await ctx.memorySpace.deleteSpace("u1", space.memorySpaceId)
  console.log("软删后 d1 解析：", await ctx.memorySpace.resolveMemorySpace("u1", "d1"))
} finally {
  for (const fiber of fibers.reverse()) {
    await fiber.dispose()
  }
}
