/* global AbortController */
import assert from "node:assert/strict"
import test from "node:test"
import { Context } from "cordis"
import { EmbeddingAdapter, EmbeddingError, EmbeddingRuntime } from "toy-embedding"

async function setup(t) {
  const ctx = new Context()
  await ctx.plugin(EmbeddingRuntime)
  t.after(() => ctx.fiber.dispose())
  return ctx.embedding
}

/** 抛出一个指定 code（可标记 retryable）的 EmbeddingError。 */
function failingAdapter(code, retryable = true) {
  return new (class extends EmbeddingAdapter {
    async embed() {
      throw new EmbeddingError(`fail ${code}`, code, { retryable })
    }
  })()
}

/** 返回与文本一一对应的向量。 */
function okAdapter(modelId) {
  return new (class extends EmbeddingAdapter {
    async embed(request) {
      return {
        vectors: request.texts.map((_, index) => [index]),
        modelId,
        dimensions: 1,
      }
    }
  })()
}

test("Embedding 降级链：首个候选可降级失败时自动尝试下一个", async (t) => {
  const embedding = await setup(t)
  let secondCalls = 0
  class Second extends EmbeddingAdapter {
    async embed(request) {
      secondCalls += 1
      assert.equal(request.model, "flash")
      return { vectors: [[1], [2]], modelId: "flash", dimensions: 1 }
    }
  }
  embedding.registerAdapter("a", failingAdapter("TRANSPORT"))
  embedding.registerAdapter("b", new Second())
  embedding.registerChain("main", [
    { provider: "a", model: "max" },
    { provider: "b", model: "flash" },
  ])
  const result = await embedding.embed({ provider: "main", model: "ignored", texts: ["x", "y"] })
  assert.equal(result.modelId, "flash")
  assert.equal(secondCalls, 1)
})

test("Embedding 降级链：全部失败返回 FALLBACK_EXHAUSTED 并携带 attempts", async (t) => {
  const embedding = await setup(t)
  embedding.registerAdapter("a", failingAdapter("TRANSPORT"))
  embedding.registerAdapter("b", failingAdapter("TIMEOUT"))
  embedding.registerChain("main", [
    { provider: "a", model: "m1" },
    { provider: "b", model: "m2" },
  ])
  await assert.rejects(embedding.embed({ provider: "main", model: "x", texts: ["t"] }), (error) => {
    assert.equal(error.code, "FALLBACK_EXHAUSTED")
    assert.deepEqual(error.attempts.map((failure) => failure.code), ["TRANSPORT", "TIMEOUT"])
    assert.deepEqual(error.attempts.map((failure) => failure.model), ["m1", "m2"])
    return true
  })
})

test("Embedding 降级链：不可降级失败直接返回，不尝试下一个", async (t) => {
  const embedding = await setup(t)
  let secondCalls = 0
  class Second extends EmbeddingAdapter {
    async embed() {
      secondCalls += 1
      return { vectors: [[1]], modelId: "m2", dimensions: 1 }
    }
  }
  embedding.registerAdapter("a", failingAdapter("INVALID_REQUEST", false))
  embedding.registerAdapter("b", new Second())
  embedding.registerChain("main", [
    { provider: "a", model: "m1" },
    { provider: "b", model: "m2" },
  ])
  await assert.rejects(embedding.embed({ provider: "main", model: "x", texts: ["t"] }), {
    code: "INVALID_REQUEST",
  })
  assert.equal(secondCalls, 0)
})

test("Embedding 降级链：取消不触发降级", async (t) => {
  const embedding = await setup(t)
  let secondCalls = 0
  class Second extends EmbeddingAdapter {
    async embed() {
      secondCalls += 1
      return { vectors: [[1]], modelId: "m2", dimensions: 1 }
    }
  }
  embedding.registerAdapter("a", failingAdapter("TRANSPORT"))
  embedding.registerAdapter("b", new Second())
  embedding.registerChain("main", [
    { provider: "a", model: "m1" },
    { provider: "b", model: "m2" },
  ])
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(
    embedding.embed({ provider: "main", model: "x", texts: ["t"], signal: controller.signal }),
    { code: "ABORTED" },
  )
  assert.equal(secondCalls, 0)
})

test("Embedding 降级链：onFallback 回调收到失败候选与原因", async (t) => {
  const embedding = await setup(t)
  const fallbacks = []
  embedding.registerAdapter("a", failingAdapter("TRANSPORT"))
  embedding.registerAdapter("b", okAdapter("m2"))
  embedding.registerChain(
    "main",
    [
      { provider: "a", model: "m1" },
      { provider: "b", model: "m2" },
    ],
    {
      onFallback: (attempt, entry, failure) => fallbacks.push({ attempt, entry, failure }),
    },
  )
  await embedding.embed({ provider: "main", model: "x", texts: ["t"] })
  assert.equal(fallbacks.length, 1)
  assert.equal(fallbacks[0].attempt, 0)
  assert.equal(fallbacks[0].entry.model, "m1")
  assert.equal(fallbacks[0].failure.code, "TRANSPORT")
})

test("Embedding 降级链：providerInfo 返回链名快照", async (t) => {
  const embedding = await setup(t)
  embedding.registerAdapter("a", okAdapter("m"))
  embedding.registerChain("main", [{ provider: "a", model: "m" }])
  assert.deepEqual(embedding.providerInfo("main"), { id: "main", name: "main" })
})

test("Embedding 降级链注册校验", async (t) => {
  const embedding = await setup(t)
  embedding.registerAdapter("a", okAdapter("m"))
  assert.throws(() => embedding.registerChain("", [{ provider: "a", model: "m" }]), {
    code: "INVALID_REQUEST",
  })
  assert.throws(() => embedding.registerChain("c", []), { code: "INVALID_REQUEST" })
  assert.throws(() => embedding.registerChain("c", [{ provider: "nope", model: "m" }]), {
    code: "NO_ADAPTER",
  })
  embedding.registerChain("c", [{ provider: "a", model: "m" }])
  assert.throws(() => embedding.registerChain("c", [{ provider: "a", model: "m" }]), {
    code: "DUPLICATE_ADAPTER",
  })
  assert.throws(() => embedding.registerAdapter("c", okAdapter("m")), {
    code: "DUPLICATE_ADAPTER",
  })
})
