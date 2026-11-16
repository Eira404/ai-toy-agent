/* global AbortController */
import assert from "node:assert/strict"
import test from "node:test"
import { Context } from "cordis"
import { LlmAdapter, LlmError, LlmRuntime } from "toy-llm"

async function setup(t) {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  t.after(() => ctx.fiber.dispose())
  return ctx.llm
}

/** 抛出一个指定 code 的 LlmError。 */
function failingAdapter(code) {
  return new (class extends LlmAdapter {
    async *stream() {
      yield* []
      throw new LlmError(`fail ${code}`, code)
    }
  })()
}

/** 输出一段文本并正常结束。 */
function textAdapter(text) {
  return new (class extends LlmAdapter {
    async *stream() {
      yield { type: "text-delta", index: 0, text }
      yield { type: "finish", reason: { kind: "stop" } }
    }
  })()
}

test("降级链：首个候选可降级失败时自动尝试下一个", async (t) => {
  const llm = await setup(t)
  let secondCalls = 0
  class Second extends LlmAdapter {
    async *stream(options) {
      secondCalls += 1
      assert.equal(options.model, "flash")
      yield { type: "text-delta", index: 0, text: "备用" }
      yield { type: "finish", reason: { kind: "stop" } }
    }
  }
  llm.registerAdapter("a", failingAdapter("TRANSPORT"))
  llm.registerAdapter("b", new Second())
  llm.registerChain("main", [
    { provider: "a", model: "max" },
    { provider: "b", model: "flash" },
  ])
  const result = await llm.generate({ provider: "main", model: "ignored", messages: [] })
  assert.deepEqual(result.content, [{ type: "text", text: "备用" }])
  assert.equal(result.finish.kind, "stop")
  assert.equal(secondCalls, 1)
})

test("降级链：全部失败返回 FALLBACK_EXHAUSTED 并携带 attempts", async (t) => {
  const llm = await setup(t)
  llm.registerAdapter("a", failingAdapter("TRANSPORT"))
  llm.registerAdapter("b", failingAdapter("TIMEOUT"))
  llm.registerChain("main", [
    { provider: "a", model: "m1" },
    { provider: "b", model: "m2" },
  ])
  const result = await llm.generate({ provider: "main", model: "x", messages: [] })
  assert.equal(result.finish.kind, "error")
  assert.equal(result.finish.failure.code, "FALLBACK_EXHAUSTED")
  assert.deepEqual(
    result.finish.failure.attempts.map((failure) => failure.code),
    ["TRANSPORT", "TIMEOUT"],
  )
})

test("降级链：不可降级失败直接返回，不尝试下一个", async (t) => {
  const llm = await setup(t)
  let secondCalls = 0
  class Second extends LlmAdapter {
    async *stream() {
      secondCalls += 1
      yield { type: "finish", reason: { kind: "stop" } }
    }
  }
  llm.registerAdapter("a", failingAdapter("INVALID_REQUEST"))
  llm.registerAdapter("b", new Second())
  llm.registerChain("main", [
    { provider: "a", model: "m1" },
    { provider: "b", model: "m2" },
  ])
  const result = await llm.generate({ provider: "main", model: "x", messages: [] })
  assert.equal(result.finish.failure.code, "INVALID_REQUEST")
  assert.equal(secondCalls, 0)
})

test("降级链：取消不触发降级", async (t) => {
  const llm = await setup(t)
  let secondCalls = 0
  class Second extends LlmAdapter {
    async *stream() {
      secondCalls += 1
      yield { type: "finish", reason: { kind: "stop" } }
    }
  }
  llm.registerAdapter("a", failingAdapter("TRANSPORT"))
  llm.registerAdapter("b", new Second())
  llm.registerChain("main", [
    { provider: "a", model: "m1" },
    { provider: "b", model: "m2" },
  ])
  const controller = new AbortController()
  controller.abort()
  const result = await llm.generate({
    provider: "main",
    model: "x",
    messages: [],
    signal: controller.signal,
  })
  assert.equal(result.finish.kind, "aborted")
  assert.equal(secondCalls, 0)
})

test("流式降级：首 token 前失败会切换候选", async (t) => {
  const llm = await setup(t)
  llm.registerAdapter("a", failingAdapter("TRANSPORT"))
  llm.registerAdapter("b", textAdapter("ok"))
  llm.registerChain("main", [
    { provider: "a", model: "m1" },
    { provider: "b", model: "m2" },
  ])
  const chunks = []
  for await (const chunk of llm.stream({ provider: "main", model: "x", messages: [] })) {
    chunks.push(chunk)
  }
  assert.deepEqual(chunks.map((chunk) => chunk.type), ["text-delta", "finish"])
  assert.equal(chunks.at(-1).reason.kind, "stop")
})

test("流式降级：吐出内容后失败不再切换", async (t) => {
  const llm = await setup(t)
  let secondCalls = 0
  class First extends LlmAdapter {
    async *stream() {
      yield { type: "text-delta", index: 0, text: "半句" }
      throw new LlmError("网络失败", "TRANSPORT")
    }
  }
  class Second extends LlmAdapter {
    async *stream() {
      secondCalls += 1
      yield { type: "finish", reason: { kind: "stop" } }
    }
  }
  llm.registerAdapter("a", new First())
  llm.registerAdapter("b", new Second())
  llm.registerChain("main", [
    { provider: "a", model: "m1" },
    { provider: "b", model: "m2" },
  ])
  const chunks = []
  for await (const chunk of llm.stream({ provider: "main", model: "x", messages: [] })) {
    chunks.push(chunk)
  }
  assert.deepEqual(chunks.map((chunk) => chunk.type), ["text-delta", "finish"])
  assert.equal(chunks.at(-1).reason.kind, "error")
  assert.equal(chunks.at(-1).reason.failure.code, "TRANSPORT")
  assert.equal(secondCalls, 0)
})

test("降级链：切换候选时丢弃指向其它模型的续调句柄", async (t) => {
  const llm = await setup(t)
  let seen
  class Second extends LlmAdapter {
    async *stream(options) {
      seen = options.continuation
      yield { type: "finish", reason: { kind: "stop" } }
    }
  }
  llm.registerAdapter("a", failingAdapter("TRANSPORT"))
  llm.registerAdapter("b", new Second())
  llm.registerChain("main", [
    { provider: "a", model: "m1" },
    { provider: "b", model: "m2" },
  ])
  const continuation = {
    provider: "a",
    model: "m1",
    callIds: [],
    kind: "responses-stored",
    responseId: "r1",
  }
  await llm.generate({ provider: "main", model: "x", messages: [], continuation })
  assert.equal(seen, undefined)
})

test("降级链：续调句柄匹配当前候选时保留", async (t) => {
  const llm = await setup(t)
  let seen
  class First extends LlmAdapter {
    async *stream(options) {
      seen = options.continuation
      yield { type: "finish", reason: { kind: "stop" } }
    }
  }
  llm.registerAdapter("a", new First())
  llm.registerChain("main", [{ provider: "a", model: "m1" }])
  const continuation = {
    provider: "a",
    model: "m1",
    callIds: [],
    kind: "responses-stored",
    responseId: "r1",
  }
  await llm.generate({ provider: "main", model: "x", messages: [], continuation })
  assert.deepEqual(seen, continuation)
})

test("降级链：onFallback 回调收到失败候选与原因", async (t) => {
  const llm = await setup(t)
  const fallbacks = []
  llm.registerAdapter("a", failingAdapter("TRANSPORT"))
  llm.registerAdapter("b", textAdapter("ok"))
  llm.registerChain(
    "main",
    [
      { provider: "a", model: "m1" },
      { provider: "b", model: "m2" },
    ],
    {
      onFallback: (attempt, entry, failure) => fallbacks.push({ attempt, entry, failure }),
    },
  )
  await llm.generate({ provider: "main", model: "x", messages: [] })
  assert.equal(fallbacks.length, 1)
  assert.equal(fallbacks[0].attempt, 0)
  assert.equal(fallbacks[0].entry.model, "m1")
  assert.equal(fallbacks[0].failure.code, "TRANSPORT")
})

test("降级链注册校验", async (t) => {
  const llm = await setup(t)
  llm.registerAdapter("a", textAdapter("x"))
  assert.throws(() => llm.registerChain("", [{ provider: "a", model: "m" }]), {
    code: "INVALID_REQUEST",
  })
  assert.throws(() => llm.registerChain("c", []), { code: "INVALID_REQUEST" })
  assert.throws(() => llm.registerChain("c", [{ provider: "nope", model: "m" }]), {
    code: "NO_ADAPTER",
  })
  llm.registerChain("c", [{ provider: "a", model: "m" }])
  assert.throws(() => llm.registerChain("c", [{ provider: "a", model: "m" }]), {
    code: "DUPLICATE_ADAPTER",
  })
  assert.throws(() => llm.registerAdapter("c", textAdapter("y")), {
    code: "DUPLICATE_ADAPTER",
  })
})

test("降级链：providerInfo 返回各候选的能力交集", async (t) => {
  const llm = await setup(t)
  class A extends LlmAdapter {
    providerInfo() {
      return {
        id: "a",
        name: "a",
        protocol: "responses",
        capabilities: {
          functionTools: true,
          builtinTools: ["web_search"],
          jsonSchema: true,
          reasoning: false,
        },
      }
    }

    async *stream() {
      yield { type: "finish", reason: { kind: "stop" } }
    }
  }
  class B extends LlmAdapter {
    providerInfo() {
      return {
        id: "b",
        name: "b",
        protocol: "responses",
        capabilities: {
          functionTools: true,
          builtinTools: ["web_search", "code"],
          jsonSchema: false,
          reasoning: false,
        },
      }
    }

    async *stream() {
      yield { type: "finish", reason: { kind: "stop" } }
    }
  }
  llm.registerAdapter("a", new A())
  llm.registerAdapter("b", new B())
  llm.registerChain("main", [
    { provider: "a", model: "m1" },
    { provider: "b", model: "m2" },
  ])
  const info = llm.providerInfo("main")
  assert.equal(info.protocol, "responses")
  assert.deepEqual(info.capabilities, {
    functionTools: true,
    builtinTools: ["web_search"],
    jsonSchema: false,
    reasoning: false,
  })
})
