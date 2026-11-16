/* global AbortController */
import assert from "node:assert/strict"
import test from "node:test"
import { Context } from "cordis"
import { LlmAdapter, LlmRuntime } from "toy-llm"

const options = { provider: "fake", model: "model", messages: [] }

async function setup(t) {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  t.after(() => ctx.fiber.dispose())
  return ctx.llm
}

test("注册路由并组装一次模型流，已注册能力与读取快照隔离", async (t) => {
  const llm = await setup(t)
  class Adapter extends LlmAdapter {
    async *stream(request) {
      assert.equal(request.model, "model")
      yield { type: "text-delta", index: 0, text: "你" }
      yield { type: "text-delta", index: 0, text: "好" }
      yield { type: "usage", usage: { inputTokens: 1, outputTokens: 2 } }
      yield { type: "finish", reason: { kind: "stop" } }
    }
  }
  const dispose = llm.registerAdapter("fake", new Adapter())
  assert.throws(() => llm.registerAdapter("fake", new Adapter()), { code: "DUPLICATE_ADAPTER" })
  llm.providerInfo("fake").capabilities.functionTools = false
  assert.equal(llm.listProviders()[0].capabilities.functionTools, true)
  assert.deepEqual(await llm.generate(options), {
    content: [{ type: "text", text: "你好" }],
    usage: { inputTokens: 1, outputTokens: 2 },
    finish: { kind: "stop" },
  })
  dispose()
  assert.deepEqual(llm.listProviders(), [])
  assert.equal((await llm.generate(options)).finish.failure.code, "NO_ADAPTER")
})

test("流提前退出会清理适配器，缺失 finish 被归一化为失败", async (t) => {
  const llm = await setup(t)
  let cleaned = 0
  class Adapter extends LlmAdapter {
    async *stream() {
      try {
        yield { type: "text-delta", index: 0, text: "partial" }
      } finally {
        cleaned += 1
      }
    }
  }
  llm.registerAdapter("fake", new Adapter())
  for await (const chunk of llm.stream(options)) {
    assert.equal(chunk.type, "text-delta")
    break
  }
  assert.equal(cleaned, 1)
  const result = await llm.generate(options)
  assert.equal(result.finish.kind, "error")
  assert.equal(result.finish.failure.code, "STREAM_CLOSED")
  assert.equal(cleaned, 2)
})

test("已取消的请求直接返回 aborted，不启动适配器", async (t) => {
  const llm = await setup(t)
  let invoked = false
  class Adapter extends LlmAdapter {
    async *stream() {
      invoked = true
      yield { type: "finish", reason: { kind: "stop" } }
    }
  }
  llm.registerAdapter("fake", new Adapter())
  const controller = new AbortController()
  controller.abort()
  const { finish } = await llm.generate({ ...options, signal: controller.signal })
  assert.equal(finish.kind, "aborted")
  assert.equal(finish.failure.code, "ABORTED")
  assert.equal(invoked, false)
})
