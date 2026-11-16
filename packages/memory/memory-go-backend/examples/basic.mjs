/* global console, fetch */
import { Context } from "cordis"
import { HttpServer } from "toy-backend-http"
import { MemoryGoBackend } from "toy-memory-go-backend"
import { FakeMemoryRead, FakeMemoryScheduler, FakeMemorySpace, FakeMemoryWrite } from "../test/helpers.mjs"

// 内存 mock + 真实 HTTP 服务，演示 Go 门面两条路由与 resolve-or-create + 自动 daily 调度。
const ctx = new Context()
const fibers = []
fibers.push(await ctx.plugin(HttpServer, { port: 0 }))
await ctx.http.ready
fibers.push(await ctx.plugin(FakeMemorySpace))
fibers.push(await ctx.plugin(FakeMemoryRead))
fibers.push(await ctx.plugin(FakeMemoryWrite))
fibers.push(await ctx.plugin(FakeMemoryScheduler))
fibers.push(await ctx.plugin(MemoryGoBackend))

const { port } = ctx.http.address()
const base = `http://127.0.0.1:${port}`
const context = { userId: "u1", deviceId: "d1", sessionId: "s1", turnId: "t1" }

try {
  // 1. 读：首次会创建空间并自动挂 daily 调度（03:00 / Asia/Shanghai / 阈值 10）
  const readRes = await fetch(`${base}/memory/read`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ context, query: "咖啡" }),
  })
  console.log("POST /memory/read ->", readRes.status, await readRes.text())

  // 2. 写：同一 user+device 复用空间，不再重复挂调度
  const writeRes = await fetch(`${base}/memory/write`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      context: { ...context, turnId: "t2" },
      memories: [{ title: "饮食偏好", summary: "用户不吃香菜", body: "- 用户不吃香菜。" }],
    }),
  })
  console.log("POST /memory/write ->", writeRes.status, await writeRes.text())

  console.log("新建空间:", ctx.memorySpace.createdSpaces)
  console.log("已挂 daily 调度:", ctx.memoryScheduler.schedules)
} finally {
  for (const fiber of fibers.reverse()) {
    await fiber.dispose()
  }
}
