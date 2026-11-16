/* global fetch */
import assert from "node:assert/strict"
import test from "node:test"
import { Context } from "cordis"
import { HttpServer } from "toy-backend-http"
import { MemoryGoBackend } from "../lib/index.js"
import { FakeMemoryRead, FakeMemoryScheduler, FakeMemorySpace, FakeMemoryWrite } from "./helpers.mjs"

const CONTEXT = { userId: "u1", deviceId: "d1", sessionId: "s1", turnId: "t1" }
const DRAFT = { title: "饮食偏好", summary: "用户不吃香菜", body: "- 用户不吃香菜。" }

async function setup(overrides = {}) {
  const ctx = new Context()
  const fibers = []
  fibers.push(await ctx.plugin(HttpServer, { port: 0 }))
  await ctx.http.ready
  fibers.push(await ctx.plugin(FakeMemorySpace))
  fibers.push(await ctx.plugin(FakeMemoryRead))
  fibers.push(await ctx.plugin(FakeMemoryWrite))
  fibers.push(await ctx.plugin(FakeMemoryScheduler))
  fibers.push(await ctx.plugin(MemoryGoBackend, overrides.config))
  return {
    ctx,
    backend: ctx.memoryGoBackend,
    space: ctx.memorySpace,
    read: ctx.memoryRead,
    write: ctx.memoryWrite,
    scheduler: ctx.memoryScheduler,
    port: ctx.http.address().port,
    async dispose() {
      for (const fiber of fibers.reverse()) {
        await fiber.dispose()
      }
    },
  }
}

test("read：首次调用创建空间并挂 daily 调度，返回 COMPLETE，mode 默认 weak", async () => {
  const app = await setup()
  try {
    const result = await app.backend.readMemory({ context: CONTEXT, query: "咖啡" })
    assert.equal(result.status, "COMPLETE")
    assert.equal(result.fast.length, 1)
    assert.equal(result.long.length, 1)
    assert.equal(result.fast[0].title, "咖啡偏好")
    assert.equal(result.long[0].title, "小明")

    assert.equal(app.space.createdSpaces.length, 1)
    assert.equal(app.scheduler.schedules.length, 1)
    const schedule = app.scheduler.schedules[0]
    assert.equal(schedule.userId, "u1")
    assert.equal(schedule.memorySpaceId, "space-1")
    assert.match(schedule.dailyAt, /^02:[0-5]\d$/)
    assert.equal(schedule.timeZone, "Asia/Shanghai")
    assert.equal(schedule.minPendingFast, 10)

    assert.equal(app.read.calls[0].mode, "weak")
    assert.equal(app.read.calls[0].scope.memorySpaceId, "space-1")
  } finally {
    await app.dispose()
  }
})

test("read：同一 user+device 复用空间，不重复建空间/挂调度", async () => {
  const app = await setup()
  try {
    await app.backend.readMemory({ context: CONTEXT, query: "a" })
    await app.backend.readMemory({ context: CONTEXT, query: "b" })
    assert.equal(app.space.createdSpaces.length, 1)
    assert.equal(app.scheduler.schedules.length, 1)
  } finally {
    await app.dispose()
  }
})

test("read：mode=strong 透传给 memoryRead.search", async () => {
  const app = await setup()
  try {
    await app.backend.readMemory({ context: CONTEXT, query: "a", mode: "strong" })
    assert.equal(app.read.calls[0].mode, "strong")
  } finally {
    await app.dispose()
  }
})

test("write：写入并投影 title/summary/body，返回 written + writeId", async () => {
  const app = await setup()
  try {
    const result = await app.backend.writeMemory({ context: CONTEXT, memories: [DRAFT] })
    assert.equal(result.kind, "written")
    assert.ok(result.writeId)
    assert.equal(result.records.length, 1)
    assert.deepEqual(result.records[0], DRAFT)

    const call = app.write.calls[0].input
    assert.equal(call.sessionId, "s1")
    assert.equal(call.turnId, "t1")
    assert.equal(call.scope.memorySpaceId, "space-1")
    assert.equal(call.drafts.length, 1)
  } finally {
    await app.dispose()
  }
})

test("write：空 memories 抛 invalid-input", async () => {
  const app = await setup()
  try {
    await assert.rejects(
      () => app.backend.writeMemory({ context: CONTEXT, memories: [] }),
      (error) => error.code === "invalid-input",
    )
  } finally {
    await app.dispose()
  }
})

test("read：context 缺 deviceId 抛 invalid-input", async () => {
  const app = await setup()
  try {
    await assert.rejects(
      () =>
        app.backend.readMemory({
          context: { userId: "u1", sessionId: "s1", turnId: "t1" },
          query: "a",
        }),
      (error) => error.code === "invalid-input",
    )
  } finally {
    await app.dispose()
  }
})

test("config：自定义 dailyAt/timeZone/minPendingFast 生效", async () => {
  const app = await setup({ config: { dailyAt: "05:00", timeZone: "UTC", minPendingFast: 3 } })
  try {
    await app.backend.readMemory({ context: CONTEXT, query: "a" })
    assert.deepEqual(app.scheduler.schedules[0], {
      userId: "u1",
      memorySpaceId: "space-1",
      dailyAt: "05:00",
      timeZone: "UTC",
      minPendingFast: 3,
    })
  } finally {
    await app.dispose()
  }
})

test("HTTP：POST /memory/read 与 /memory/write 走 envelope，错误走 400", async () => {
  const app = await setup()
  try {
    const base = `http://127.0.0.1:${app.port}`

    const readRes = await fetch(`${base}/memory/read`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ context: CONTEXT, query: "咖啡" }),
    })
    assert.equal(readRes.status, 200)
    const readBody = await readRes.json()
    assert.equal(readBody.ok, true)
    assert.equal(readBody.data.status, "COMPLETE")

    const writeRes = await fetch(`${base}/memory/write`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ context: CONTEXT, memories: [DRAFT] }),
    })
    assert.equal(writeRes.status, 200)
    const writeBody = await writeRes.json()
    assert.equal(writeBody.ok, true)
    assert.equal(writeBody.data.kind, "written")
    assert.equal(writeBody.data.records.length, 1)

    const badRes = await fetch(`${base}/memory/read`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ context: { userId: "u1" }, query: "x" }),
    })
    assert.equal(badRes.status, 400)
    const badBody = await badRes.json()
    assert.equal(badBody.ok, false)
    assert.equal(badBody.error.code, "invalid-input")
  } finally {
    await app.dispose()
  }
})
