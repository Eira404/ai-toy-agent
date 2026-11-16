/* global console, process, fetch */
import { Context } from "cordis"
import { HttpServer } from "toy-backend-http"

const host = process.env.HOST ?? "127.0.0.1"
const port = Number.parseInt(process.env.PORT ?? "3000", 10)

const ctx = new Context()
await ctx.plugin(HttpServer, { host, port })
await ctx.http.ready

// ① JSON 路由：路径参数 + 查询串
ctx.http.get("/echo/:value", (c) => ({ value: c.params.value, q: c.query.get("x") }))

// ② POST：JSON 请求体
ctx.http.post("/sum", (c) => ({ sum: c.body.a + c.body.b }))

// ③ 业务错误：错误 code 映射为状态码（invalid-input → 400）
ctx.http.get("/boom", () => {
  throw Object.assign(new Error("输入无效"), { code: "invalid-input" })
})

// ④ SSE 流式：用 emit 逐事件写出，handler 返回后结束流
ctx.http.sse("/ticks", async (c, emit) => {
  emit({ n: 1 })
  emit({ n: 2 })
  emit({ n: 3 })
})

const bound = ctx.http.address()
const base = `http://127.0.0.1:${bound?.port}`
console.log(`HTTP server listening on http://${bound?.host}:${bound?.port}`)
console.log("  GET  /echo/:value?x=...   路径参数 + 查询串")
console.log("  POST /sum                  请求体 { a, b }")
console.log("  GET  /boom                 业务错误 → 400")
console.log("  POST /ticks                SSE 流式（3 个事件）")

// 自检：依次调用上面的路由
console.log("  自检 /echo/hello?x=1 ->", JSON.stringify(await (await fetch(`${base}/echo/hello?x=1`)).json()))
console.log(
  "  自检 /sum {a:2,b:3} ->",
  JSON.stringify(
    await (
      await fetch(`${base}/sum`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ a: 2, b: 3 }),
      })
    ).json(),
  ),
)
console.log("  自检 /boom ->", (await fetch(`${base}/boom`)).status)
const sse = await (await fetch(`${base}/ticks`, { method: "POST" })).text()
console.log("  自检 /ticks ->", sse.replaceAll("\n", " ").trim())

// 优雅停机：卸载时关闭 HTTP 服务
async function shutdown(signal) {
  console.log(`\n收到 ${signal}，开始停机…`)
  await ctx.fiber.dispose()
  console.log("已停机")
  process.exit(0)
}
process.once("SIGINT", () => void shutdown("SIGINT"))
process.once("SIGTERM", () => void shutdown("SIGTERM"))
