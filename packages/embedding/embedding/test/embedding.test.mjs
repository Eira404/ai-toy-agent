/* global AbortController */
import assert from "node:assert/strict"
import test from "node:test"
import { Context } from "cordis"
import { EmbeddingAdapter, EmbeddingRuntime } from "toy-embedding"

const request = { provider: "fake", model: "model", texts: ["a", "b"] }

async function setup(t) {
  const ctx = new Context()
  await ctx.plugin(EmbeddingRuntime)
  t.after(() => ctx.fiber.dispose())
  return ctx.embedding
}

test("注册路由并执行一次批量嵌入，返回快照与读取隔离", async (t) => {
  const embedding = await setup(t)
  class Adapter extends EmbeddingAdapter {
    async embed(request) {
      assert.equal(request.model, "model")
      return {
        vectors: [
          [0.1, 0.2],
          [0.3, 0.4],
        ],
        modelId: "model",
        dimensions: 2,
      }
    }
  }
  const dispose = embedding.registerAdapter("fake", new Adapter())
  assert.throws(() => embedding.registerAdapter("fake", new Adapter()), {
    code: "DUPLICATE_ADAPTER",
  })
  embedding.providerInfo("fake").name = "changed"
  assert.equal(embedding.listProviders()[0].name, "fake")
  assert.deepEqual(await embedding.embed(request), {
    vectors: [
      [0.1, 0.2],
      [0.3, 0.4],
    ],
    modelId: "model",
    dimensions: 2,
  })
  dispose()
  assert.deepEqual(embedding.listProviders(), [])
  await assert.rejects(embedding.embed(request), { code: "NO_ADAPTER" })
})

test("空文本和空模型在启动适配器前被拒绝", async (t) => {
  const embedding = await setup(t)
  let invoked = false
  class Adapter extends EmbeddingAdapter {
    async embed() {
      invoked = true
      return { vectors: [], modelId: "model", dimensions: 1 }
    }
  }
  embedding.registerAdapter("fake", new Adapter())
  await assert.rejects(embedding.embed({ provider: "fake", model: "model", texts: [] }), {
    code: "INVALID_REQUEST",
  })
  await assert.rejects(embedding.embed({ provider: "fake", model: "  ", texts: ["a"] }), {
    code: "INVALID_REQUEST",
  })
  assert.equal(invoked, false)
})

test("结果数量与输入不一致时归一化为失败", async (t) => {
  const embedding = await setup(t)
  class Adapter extends EmbeddingAdapter {
    async embed() {
      return { vectors: [[1]], modelId: "model", dimensions: 1 }
    }
  }
  embedding.registerAdapter("fake", new Adapter())
  await assert.rejects(embedding.embed(request), { code: "INVALID_RESPONSE" })
})

test("已取消的请求返回 aborted，不启动适配器", async (t) => {
  const embedding = await setup(t)
  let invoked = false
  class Adapter extends EmbeddingAdapter {
    async embed() {
      invoked = true
      return { vectors: [[1]], modelId: "model", dimensions: 1 }
    }
  }
  embedding.registerAdapter("fake", new Adapter())
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(embedding.embed({ ...request, signal: controller.signal }), {
    code: "ABORTED",
  })
  assert.equal(invoked, false)
})
