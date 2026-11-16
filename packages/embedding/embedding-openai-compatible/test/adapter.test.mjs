/* global AbortController, Headers, Response */
import assert from "node:assert/strict"
import test from "node:test"
import { Context } from "cordis"
import { EmbeddingRuntime } from "toy-embedding"
import { EmbeddingOpenAICompatiblePlugin } from "toy-embedding-openai-compatible"

const request = { provider: "test", model: "model", texts: ["a", "b"] }

async function setup(t, fetch, options = {}) {
  const ctx = new Context()
  await ctx.plugin(EmbeddingRuntime)
  await ctx.plugin(EmbeddingOpenAICompatiblePlugin, {
    provider: "test",
    baseURL: "https://provider.test/v1/",
    apiKey: "fixture-key",
    fetch,
    ...options,
  })
  t.after(() => ctx.fiber.dispose())
  return ctx.embedding
}

test("发送 /embeddings 请求并携带认证、模型和维度", async (t) => {
  const embedding = await setup(
    t,
    async (url, request) => {
      assert.equal(url, "https://provider.test/v1/embeddings")
      assert.equal(new Headers(request.headers).get("authorization"), "Bearer fixture-key")
      const body = JSON.parse(request.body)
      assert.equal(body.model, "model")
      assert.deepEqual(body.input, ["你好", "世界"])
      assert.equal(body.dimensions, 4)
      return new Response(
        JSON.stringify({
          data: [
            { index: 0, embedding: [0.1, 0.2, 0.3, 0.4] },
            { index: 1, embedding: [0.5, 0.6, 0.7, 0.8] },
          ],
          model: "model",
        }),
      )
    },
    { dimensions: 4 },
  )
  assert.deepEqual(
    await embedding.embed({ provider: "test", model: "model", texts: ["你好", "世界"] }),
    {
      vectors: [
        [0.1, 0.2, 0.3, 0.4],
        [0.5, 0.6, 0.7, 0.8],
      ],
      modelId: "model",
      dimensions: 4,
    },
  )
})

test("按 index 重排乱序响应", async (t) => {
  const embedding = await setup(
    t,
    async () =>
      new Response(
        JSON.stringify({
          data: [
            { index: 1, embedding: [0.3] },
            { index: 0, embedding: [0.1] },
          ],
          model: "model",
        }),
      ),
  )
  const result = await embedding.embed(request)
  assert.deepEqual(result.vectors, [[0.1], [0.3]])
})

test("超过 batchSize 时分块请求并按原始顺序合并", async (t) => {
  const seen = []
  const embedding = await setup(
    t,
    async (_url, request) => {
      const body = JSON.parse(request.body)
      seen.push(body.input)
      return new Response(
        JSON.stringify({
          data: body.input.map((text, index) => ({ index, embedding: [text.length] })),
          model: "model",
        }),
      )
    },
    { batchSize: 2 },
  )
  const result = await embedding.embed({
    provider: "test",
    model: "model",
    texts: ["a", "bb", "ccc", "dddd", "e"],
  })
  assert.deepEqual(seen, [["a", "bb"], ["ccc", "dddd"], ["e"]])
  assert.deepEqual(result.vectors, [[1], [2], [3], [4], [1]])
})

test("HTTP 429 返回诊断信息且可重试", async (t) => {
  const embedding = await setup(
    t,
    async () =>
      new Response("try later", {
        status: 429,
        headers: { "retry-after": "2", "x-request-id": "request-1" },
      }),
  )
  await assert.rejects(embedding.embed(request), (error) => {
    assert.equal(error.code, "RATE_LIMIT")
    assert.equal(error.status, 429)
    assert.equal(error.retryAfterMs, 2000)
    assert.equal(error.requestId, "request-1")
    assert.equal(error.retryable, true)
    return true
  })
})

test("Provider 返回无效 JSON 时归一化为失败", async (t) => {
  const embedding = await setup(t, async () => new Response("not json"))
  await assert.rejects(embedding.embed(request), { code: "INVALID_RESPONSE" })
})

test("Provider 返回维度与配置不一致时拒绝", async (t) => {
  const embedding = await setup(
    t,
    async () =>
      new Response(
        JSON.stringify({
          data: [{ index: 0, embedding: [0.1, 0.2] }],
          model: "model",
        }),
      ),
    { dimensions: 3 },
  )
  await assert.rejects(embedding.embed(request), { code: "INVALID_RESPONSE" })
})

test("调用方信号中断请求时归一化为 aborted", async (t) => {
  const controller = new AbortController()
  const embedding = await setup(t, async () => {
    controller.abort()
    throw new Error("connection reset")
  })
  await assert.rejects(embedding.embed({ ...request, signal: controller.signal }), {
    code: "ABORTED",
  })
})
