/* global AbortController */
import assert from "node:assert/strict"
import test from "node:test"
import { Context } from "cordis"
import { JevAdapter, JevError, JevRuntime } from "toy-jev"

const questions = {
  mood: { type: "choice", instructions: "判断情绪", criteria: { calm: "平静", happy: "开心" } },
}
const answer = { type: "choice", choice: "calm", confidence: 0.9, probabilities: { calm: 0.9 } }

async function setup(t) {
  const ctx = new Context()
  await ctx.plugin(JevRuntime)
  t.after(() => ctx.fiber.dispose())
  return ctx.jev
}

/** 抛出一个指定 code（可标记 retryable）的 JevError。 */
function failingAdapter(code, retryable = true) {
  return new (class extends JevAdapter {
    async invoke() {
      throw new JevError(`fail ${code}`, code, { retryable })
    }
  })()
}

/** 返回一个合法答案，model 取请求中的 provider。 */
function okAdapter() {
  return new (class extends JevAdapter {
    async invoke(request) {
      return { model: request.provider, answers: { mood: answer } }
    }
  })()
}

test("JEV 降级链：首个候选可降级失败时自动尝试下一个", async (t) => {
  const jev = await setup(t)
  let secondCalls = 0
  class Second extends JevAdapter {
    async invoke(request) {
      secondCalls += 1
      return { model: request.provider, answers: { mood: answer } }
    }
  }
  jev.registerAdapter("a", failingAdapter("TRANSPORT"))
  jev.registerAdapter("b", new Second())
  jev.registerChain("main", [{ provider: "a", model: "m-a" }, { provider: "b", model: "m-b" }])
  const result = await jev.invoke("state", questions, { provider: "main" })
  assert.equal(result.model, "b")
  assert.equal(secondCalls, 1)
})

test("JEV 降级链：全部失败返回 FALLBACK_EXHAUSTED 并携带 attempts", async (t) => {
  const jev = await setup(t)
  jev.registerAdapter("a", failingAdapter("TRANSPORT"))
  jev.registerAdapter("b", failingAdapter("TIMEOUT"))
  jev.registerChain("main", [{ provider: "a", model: "m-a" }, { provider: "b", model: "m-b" }])
  await assert.rejects(jev.invoke("state", questions, { provider: "main" }), (error) => {
    assert.equal(error.code, "FALLBACK_EXHAUSTED")
    assert.deepEqual(error.attempts.map((failure) => failure.code), ["TRANSPORT", "TIMEOUT"])
    return true
  })
})

test("JEV 降级链：不可降级失败直接返回，不尝试下一个", async (t) => {
  const jev = await setup(t)
  let secondCalls = 0
  class Second extends JevAdapter {
    async invoke() {
      secondCalls += 1
      return { model: "b", answers: { mood: answer } }
    }
  }
  jev.registerAdapter("a", failingAdapter("INVALID_REQUEST", false))
  jev.registerAdapter("b", new Second())
  jev.registerChain("main", [{ provider: "a", model: "m-a" }, { provider: "b", model: "m-b" }])
  await assert.rejects(jev.invoke("state", questions, { provider: "main" }), {
    code: "INVALID_REQUEST",
  })
  assert.equal(secondCalls, 0)
})

test("JEV 降级链：取消不触发降级", async (t) => {
  const jev = await setup(t)
  let secondCalls = 0
  class Second extends JevAdapter {
    async invoke() {
      secondCalls += 1
      return { model: "b", answers: { mood: answer } }
    }
  }
  jev.registerAdapter("a", failingAdapter("TRANSPORT"))
  jev.registerAdapter("b", new Second())
  jev.registerChain("main", [{ provider: "a", model: "m-a" }, { provider: "b", model: "m-b" }])
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(
    jev.invoke("state", questions, { provider: "main", signal: controller.signal }),
    { code: "ABORTED" },
  )
  assert.equal(secondCalls, 0)
})

test("JEV 降级链：onFallback 回调收到失败候选与原因", async (t) => {
  const jev = await setup(t)
  const fallbacks = []
  jev.registerAdapter("a", failingAdapter("TRANSPORT"))
  jev.registerAdapter("b", okAdapter())
  jev.registerChain("main", [{ provider: "a", model: "m-a" }, { provider: "b", model: "m-b" }], {
    onFallback: (attempt, provider, failure) => fallbacks.push({ attempt, provider, failure }),
  })
  await jev.invoke("state", questions, { provider: "main" })
  assert.equal(fallbacks.length, 1)
  assert.equal(fallbacks[0].attempt, 0)
  assert.equal(fallbacks[0].provider, "a")
  assert.equal(fallbacks[0].failure.code, "TRANSPORT")
})

test("JEV 降级链：链条目 model 传给 adapter", async (t) => {
  const jev = await setup(t)
  const seen = []
  class Recorder extends JevAdapter {
    async invoke(request) {
      seen.push(request.model)
      return { model: request.model ?? "none", answers: { mood: answer } }
    }
  }
  jev.registerAdapter("typesafe", new Recorder())
  jev.registerChain("main", [{ provider: "typesafe", model: "jev-1.14.0" }])
  const result = await jev.invoke("state", questions, { provider: "main" })
  assert.equal(result.model, "jev-1.14.0")
  assert.deepEqual(seen, ["jev-1.14.0"])
})

test("JEV 降级链：同一 adapter 不同 model 依次降级", async (t) => {
  const jev = await setup(t)
  const seen = []
  class ModelAware extends JevAdapter {
    async invoke(request) {
      seen.push(request.model)
      if (request.model === "jev-1.14.0") {
        throw new JevError("model down", "TRANSPORT", { retryable: true })
      }
      return { model: request.model, answers: { mood: answer } }
    }
  }
  jev.registerAdapter("typesafe", new ModelAware())
  jev.registerChain("main", [
    { provider: "typesafe", model: "jev-1.14.0" },
    { provider: "typesafe", model: "jev-1.13.0" },
  ])
  const result = await jev.invoke("state", questions, { provider: "main" })
  assert.equal(result.model, "jev-1.13.0")
  assert.deepEqual(seen, ["jev-1.14.0", "jev-1.13.0"])
})

test("JEV 降级链注册校验", async (t) => {
  const jev = await setup(t)
  jev.registerAdapter("a", okAdapter())
  assert.throws(() => jev.registerChain("", [{ provider: "a", model: "m-a" }]), { code: "INVALID_REQUEST" })
  assert.throws(() => jev.registerChain("c", []), { code: "INVALID_REQUEST" })
  assert.throws(() => jev.registerChain("c", [{ provider: "nope", model: "m" }]), { code: "NO_ADAPTER" })
  jev.registerChain("c", [{ provider: "a", model: "m-a" }])
  assert.throws(() => jev.registerChain("c", [{ provider: "a", model: "m-a" }]), { code: "DUPLICATE_ADAPTER" })
  assert.throws(() => jev.registerAdapter("c", okAdapter()), { code: "DUPLICATE_ADAPTER" })
})
