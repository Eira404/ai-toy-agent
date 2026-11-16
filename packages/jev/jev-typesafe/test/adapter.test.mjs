/* global AbortController, Headers, Response */
import assert from "node:assert/strict"
import test from "node:test"
import { Context } from "cordis"
import { JevRuntime } from "toy-jev"
import { JevTypesafePlugin } from "toy-jev-typesafe"

const questions = { mood: { type: "noul", instructions: "判断平静程度" } }

async function setup(t, fetch, extra = {}) {
  const ctx = new Context()
  await ctx.plugin(JevRuntime)
  const fiber = await ctx.plugin(JevTypesafePlugin, {
    baseURL: "https://provider.test/",
    apiKey: "fixture-key",
    fetch,
    ...extra,
  })
  t.after(() => ctx.fiber.dispose())
  return { jev: ctx.jev, fiber }
}

test("构造 TypeSafe HTTP 请求并返回已校验的结果，插件卸载时注销", async (t) => {
  const response = { model: "demo", answers: { mood: { type: "noul", noul: 0.5 } } }
  const { jev, fiber } = await setup(t, async (url, request) => {
    assert.equal(url, "https://provider.test/typesafe/v1/systemone")
    assert.equal(request.method, "POST")
    assert.equal(new Headers(request.headers).get("authorization"), "Bearer fixture-key")
    assert.deepEqual(JSON.parse(request.body), { model: "demo", state: "state", questions })
    return Response.json(response)
  })
  assert.deepEqual(await jev.invoke("state", questions, { model: "demo" }), response)
  await fiber.dispose()
  assert.deepEqual(jev.listProviders(), [])
})

test("429 提供重试提示，响应格式错误被拒绝", async (t) => {
  let calls = 0
  const { jev } = await setup(t, async () => {
    calls += 1
    if (calls === 1) {
      return new Response("try later", {
        status: 429,
        headers: { "retry-after": "3", "x-request-id": "r1" },
      })
    }
    return Response.json({ answers: [] })
  })
  await assert.rejects(jev.invoke("state", questions, { model: "demo" }), {
    code: "RATE_LIMIT",
    retryable: true,
    status: 429,
    retryAfterMs: 3000,
    requestId: "r1",
  })
  assert.equal(calls, 1)
  await assert.rejects(jev.invoke("state", questions, { model: "demo" }), { code: "INVALID_RESPONSE" })
})

test("区分 HTTP 请求超时和调用方取消", async (t) => {
  const { jev } = await setup(
    t,
    async (_url, { signal }) => {
      await new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true })
      })
    },
    { timeoutMs: 20 },
  )
  await assert.rejects(jev.invoke("state", questions, { model: "demo" }), { code: "TIMEOUT", retryable: true })
  const controller = new AbortController()
  const result = jev.invoke("state", questions, { model: "demo", signal: controller.signal })
  controller.abort()
  await assert.rejects(result, { code: "ABORTED", retryable: false })
})
