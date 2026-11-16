import assert from "node:assert/strict"
import test from "node:test"
import { Context } from "cordis"
import { HttpServer } from "toy-backend-http"

test("路由注册与调用：路径参数、查询串与 JSON 请求体", async () => {
  const ctx = new Context()
  await ctx.plugin(HttpServer, { port: 0 })
  await ctx.http.ready

  ctx.http.get("/echo/:value", (c) => ({ value: c.params.value, q: c.query.get("x") }))
  ctx.http.post("/sum", (c) => ({ sum: c.body.a + c.body.b }))

  try {
    const base = `http://127.0.0.1:${ctx.http.address().port}`

    const echo = await (await fetch(`${base}/echo/hello?x=1`)).json()
    assert.deepEqual(echo, { ok: true, data: { value: "hello", q: "1" } })

    const sum = await (
      await fetch(`${base}/sum`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ a: 2, b: 3 }),
      })
    ).json()
    assert.deepEqual(sum, { ok: true, data: { sum: 5 } })
  } finally {
    await ctx.fiber.dispose()
  }
})

test("404 与业务错误映射", async () => {
  const ctx = new Context()
  await ctx.plugin(HttpServer, { port: 0 })
  await ctx.http.ready

  ctx.http.get("/boom", () => {
    throw Object.assign(new Error("输入无效"), { code: "invalid-input" })
  })

  try {
    const base = `http://127.0.0.1:${ctx.http.address().port}`

    const missing = await fetch(`${base}/nope`)
    assert.equal(missing.status, 404)
    assert.deepEqual(await missing.json(), {
      ok: false,
      error: { code: "not-found", message: "没有匹配的路由：GET /nope" },
    })

    const boom = await fetch(`${base}/boom`)
    assert.equal(boom.status, 400)
    assert.deepEqual(await boom.json(), {
      ok: false,
      error: { code: "invalid-input", message: "输入无效" },
    })
  } finally {
    await ctx.fiber.dispose()
  }
})

test("SSE 路由：逐事件写出", async () => {
  const ctx = new Context()
  await ctx.plugin(HttpServer, { port: 0 })
  await ctx.http.ready

  ctx.http.sse("/ticks", async (c, emit) => {
    emit({ n: 1 })
    emit({ n: 2 })
    emit({ n: 3 })
  })

  try {
    const base = `http://127.0.0.1:${ctx.http.address().port}`
    const res = await fetch(`${base}/ticks`, { method: "POST" })
    assert.equal(res.headers.get("content-type"), "text/event-stream")
    assert.deepEqual(parseSse(await res.text()), [{ n: 1 }, { n: 2 }, { n: 3 }])
  } finally {
    await ctx.fiber.dispose()
  }
})

test("请求头可读：键为小写", async () => {
  const ctx = new Context()
  await ctx.plugin(HttpServer, { port: 0 })
  await ctx.http.ready

  ctx.http.get("/headers", (c) => ({
    auth: c.headers.authorization,
    requestId: c.headers["x-request-id"],
  }))

  try {
    const base = `http://127.0.0.1:${ctx.http.address().port}`
    const res = await (
      await fetch(`${base}/headers`, {
        headers: { authorization: "Bearer abc123", "x-request-id": "req-1" },
      })
    ).json()
    assert.deepEqual(res, {
      ok: true,
      data: { auth: "Bearer abc123", requestId: "req-1" },
    })
  } finally {
    await ctx.fiber.dispose()
  }
})

function parseSse(text) {
  return text
    .split("\n\n")
    .map((block) => block.trim())
    .filter((block) => block.length > 0)
    .map((block) => {
      const line = block.split("\n").find((l) => l.startsWith("data: "))
      return line === undefined ? null : JSON.parse(line.slice(6))
    })
    .filter((event) => event !== null)
}
