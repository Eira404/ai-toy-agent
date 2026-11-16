/* global structuredClone */
import assert from "node:assert/strict"
import test from "node:test"
import { Context } from "cordis"
import { ToyStorage } from "toy-storage"
import { MemorySpaceService, spaceRelationalSchema } from "../lib/index.js"
import { FakeRelational } from "./helpers.mjs"

const NOW = "2026-11-09T00:00:00.000Z"

async function setup(overrides = {}) {
  const ctx = new Context()
  const fibers = []
  fibers.push(await ctx.plugin(ToyStorage))
  fibers.push(await ctx.plugin(FakeRelational, { schema: spaceRelationalSchema }))
  fibers.push(await ctx.plugin(MemorySpaceService, { now: () => NOW, ...overrides }))
  return {
    ctx,
    memorySpace: ctx.memorySpace,
    async dispose() {
      for (const fiber of fibers.reverse()) {
        await fiber.dispose()
      }
    },
  }
}

test("createSpace 创建 active 空间，getSpace 读回", async () => {
  const app = await setup()
  try {
    const space = await app.memorySpace.createSpace({ userId: "u1", name: "我的空间" })
    assert.equal(space.userId, "u1")
    assert.equal(space.name, "我的空间")
    assert.equal(space.status, "active")
    assert.equal(space.createdAt, NOW)

    const read = await app.memorySpace.getSpace(space.memorySpaceId)
    assert.deepEqual(read, space)
  } finally {
    await app.dispose()
  }
})

test("createSpace 名字归一化：省略/空串为 null，超长抛错", async () => {
  const app = await setup({ maxNameLength: 4 })
  try {
    assert.equal((await app.memorySpace.createSpace({ userId: "u1" })).name, null)
    assert.equal((await app.memorySpace.createSpace({ userId: "u1", name: "  " })).name, null)
    assert.equal((await app.memorySpace.createSpace({ userId: "u1", name: " 家 " })).name, "家")
    await assert.rejects(
      app.memorySpace.createSpace({ userId: "u1", name: "一二三四五" }),
      (error) => error.code === "invalid-input",
    )
  } finally {
    await app.dispose()
  }
})

test("renameSpace 设置/清空名字，且校验归属与状态", async () => {
  const app = await setup()
  try {
    const space = await app.memorySpace.createSpace({ userId: "u1", name: "旧名" })
    const renamed = await app.memorySpace.renameSpace("u1", space.memorySpaceId, " 新名 ")
    assert.equal(renamed.name, "新名")

    const cleared = await app.memorySpace.renameSpace("u1", space.memorySpaceId, "")
    assert.equal(cleared.name, null)

    await assert.rejects(
      app.memorySpace.renameSpace("u2", space.memorySpaceId, "越权"),
      (error) => error.code === "not-owner",
    )

    await app.memorySpace.deleteSpace("u1", space.memorySpaceId)
    await assert.rejects(
      app.memorySpace.renameSpace("u1", space.memorySpaceId, "已删"),
      (error) => error.code === "space-deleted",
    )
  } finally {
    await app.dispose()
  }
})

test("deleteSpace 软删除幂等，restoreSpace 恢复", async () => {
  const app = await setup()
  try {
    const space = await app.memorySpace.createSpace({ userId: "u1" })
    const deleted = await app.memorySpace.deleteSpace("u1", space.memorySpaceId)
    assert.equal(deleted.status, "deleted")

    const again = await app.memorySpace.deleteSpace("u1", space.memorySpaceId)
    assert.equal(again.status, "deleted")

    const restored = await app.memorySpace.restoreSpace("u1", space.memorySpaceId)
    assert.equal(restored.status, "active")

    await assert.rejects(
      app.memorySpace.deleteSpace("u2", space.memorySpaceId),
      (error) => error.code === "not-owner",
    )
  } finally {
    await app.dispose()
  }
})

test("listSpaces 默认只列 active，includeDeleted 含已删", async () => {
  const app = await setup()
  try {
    const keep = await app.memorySpace.createSpace({ userId: "u1", name: "a" })
    const drop = await app.memorySpace.createSpace({ userId: "u1", name: "b" })
    await app.memorySpace.deleteSpace("u1", drop.memorySpaceId)

    const active = await app.memorySpace.listSpaces("u1")
    assert.deepEqual(active.map((s) => s.memorySpaceId), [keep.memorySpaceId])

    const all = await app.memorySpace.listSpaces("u1", { includeDeleted: true })
    assert.deepEqual(all.map((s) => s.memorySpaceId).sort(), [keep.memorySpaceId, drop.memorySpaceId].sort())
  } finally {
    await app.dispose()
  }
})

test("bindDevice 绑定/改绑幂等，listBoundDevices 列出娃娃", async () => {
  const app = await setup()
  try {
    const space = await app.memorySpace.createSpace({ userId: "u1", name: "家庭" })
    const other = await app.memorySpace.createSpace({ userId: "u1", name: "工作" })

    const binding = await app.memorySpace.bindDevice({
      userId: "u1",
      deviceId: "d1",
      memorySpaceId: space.memorySpaceId,
    })
    assert.deepEqual(binding, {
      userId: "u1",
      deviceId: "d1",
      memorySpaceId: space.memorySpaceId,
      createdAt: NOW,
    })

    // 幂等：绑定同一空间无变更
    const same = await app.memorySpace.bindDevice({
      userId: "u1",
      deviceId: "d1",
      memorySpaceId: space.memorySpaceId,
    })
    assert.deepEqual(same, binding)

    // 改绑到别的空间
    const moved = await app.memorySpace.bindDevice({
      userId: "u1",
      deviceId: "d1",
      memorySpaceId: other.memorySpaceId,
    })
    assert.equal(moved.memorySpaceId, other.memorySpaceId)

    const bound = await app.memorySpace.listBoundDevices(other.memorySpaceId)
    assert.deepEqual(bound.map((b) => b.deviceId), ["d1"])
  } finally {
    await app.dispose()
  }
})

test("bindDevice 校验目标空间 active 且属于该用户", async () => {
  const app = await setup()
  try {
    const space = await app.memorySpace.createSpace({ userId: "u1" })
    await assert.rejects(
      app.memorySpace.bindDevice({ userId: "u2", deviceId: "d1", memorySpaceId: space.memorySpaceId }),
      (error) => error.code === "not-owner",
    )

    await app.memorySpace.deleteSpace("u1", space.memorySpaceId)
    await assert.rejects(
      app.memorySpace.bindDevice({ userId: "u1", deviceId: "d1", memorySpaceId: space.memorySpaceId }),
      (error) => error.code === "space-deleted",
    )
  } finally {
    await app.dispose()
  }
})

test("unbindDevice 解绑，不存在时抛 binding-not-found", async () => {
  const app = await setup()
  try {
    const space = await app.memorySpace.createSpace({ userId: "u1" })
    await app.memorySpace.bindDevice({ userId: "u1", deviceId: "d1", memorySpaceId: space.memorySpaceId })
    await app.memorySpace.unbindDevice("u1", "d1")
    assert.equal((await app.memorySpace.listBoundDevices(space.memorySpaceId)).length, 0)

    await assert.rejects(
      app.memorySpace.unbindDevice("u1", "d1"),
      (error) => error.code === "binding-not-found",
    )
  } finally {
    await app.dispose()
  }
})

test("resolveMemorySpace 解析 active 空间，未绑定或已删空间返回 null", async () => {
  const app = await setup()
  try {
    assert.equal(await app.memorySpace.resolveMemorySpace("u1", "d1"), null)

    const space = await app.memorySpace.createSpace({ userId: "u1" })
    await app.memorySpace.bindDevice({ userId: "u1", deviceId: "d1", memorySpaceId: space.memorySpaceId })
    assert.equal(await app.memorySpace.resolveMemorySpace("u1", "d1"), space.memorySpaceId)

    // 别的用户/娃娃不命中
    assert.equal(await app.memorySpace.resolveMemorySpace("u1", "d2"), null)
    assert.equal(await app.memorySpace.resolveMemorySpace("u2", "d1"), null)

    // 空间软删后解析为 null，恢复后重新可见
    await app.memorySpace.deleteSpace("u1", space.memorySpaceId)
    assert.equal(await app.memorySpace.resolveMemorySpace("u1", "d1"), null)
    await app.memorySpace.restoreSpace("u1", space.memorySpaceId)
    assert.equal(await app.memorySpace.resolveMemorySpace("u1", "d1"), space.memorySpaceId)
  } finally {
    await app.dispose()
  }
})

test("countSpaces / countDevices 统计", async () => {
  const app = await setup()
  try {
    const space = await app.memorySpace.createSpace({ userId: "u1" })
    await app.memorySpace.createSpace({ userId: "u1" })
    await app.memorySpace.bindDevice({ userId: "u1", deviceId: "d1", memorySpaceId: space.memorySpaceId })
    await app.memorySpace.bindDevice({ userId: "u1", deviceId: "d2", memorySpaceId: space.memorySpaceId })

    assert.equal(await app.memorySpace.countSpaces("u1"), 2)
    assert.equal(await app.memorySpace.countDevices(space.memorySpaceId), 2)
  } finally {
    await app.dispose()
  }
})
