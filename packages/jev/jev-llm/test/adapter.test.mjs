import assert from "node:assert/strict"
import test from "node:test"
import { Context } from "cordis"
import { LlmAdapter, LlmError, LlmRuntime } from "toy-llm"
import { JevAdapter, JevError, JevRuntime } from "toy-jev"
import { JevLlmPlugin } from "toy-jev-llm"

const questions = { mood: { type: "noul", instructions: "判断平静程度" } }

/** 输出一段文本并正常结束的 LLM 适配器，捕获 responseFormat。 */
class TextLlm extends LlmAdapter {
  seenFormat
  constructor(text) {
    super()
    this.text = text
  }

  async *stream(options) {
    this.seenFormat = options.responseFormat
    yield { type: "text-delta", index: 0, text: this.text }
    yield { type: "finish", reason: { kind: "stop" } }
  }
}

async function setup(t, llmAdapter, config = {}) {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(JevRuntime)
  ctx.llm.registerAdapter("fake", llmAdapter)
  const fiber = await ctx.plugin(JevLlmPlugin, {
    provider: "llm",
    llmProvider: "fake",
    ...config,
  })
  t.after(() => ctx.fiber.dispose())
  return { jev: ctx.jev, fiber }
}

test("桥接把 JEV 问题转成 JSON Schema 并解析 LLM 的结构化结果", async (t) => {
  const adapter = new TextLlm(JSON.stringify({ answers: { mood: { type: "noul", noul: 0.5 } } }))
  const { jev } = await setup(t, adapter)
  const result = await jev.invoke("state", questions, { provider: "llm", model: "m" })
  assert.equal(result.model, "m")
  assert.equal(result.answers.mood.noul, 0.5)
  // 约束输出的 JSON Schema 应包含每个问题的答案结构。
  assert.equal(adapter.seenFormat.type, "json_schema")
  assert.ok(adapter.seenFormat.schema.properties.answers.properties.mood)
})

test("LLM 可降级失败时抛可重试的 JevError", async (t) => {
  class FailingLlm extends LlmAdapter {
    async *stream() {
      yield* []
      throw new LlmError("网络失败", "TRANSPORT")
    }
  }
  const { jev } = await setup(t, new FailingLlm())
  await assert.rejects(jev.invoke("state", questions, { provider: "llm", model: "m" }), {
    code: "TRANSPORT",
    retryable: true,
  })
})

test("LLM 返回非法 JSON 时归一化为 INVALID_RESPONSE", async (t) => {
  const { jev } = await setup(t, new TextLlm("not json at all"))
  await assert.rejects(jev.invoke("state", questions, { provider: "llm", model: "m" }), {
    code: "INVALID_RESPONSE",
  })
})

test("桥接可作为 JEV 降级链的兜底候选", async (t) => {
  let llmCalls = 0
  class FlakyJev extends JevAdapter {
    async invoke() {
      throw new JevError("评估服务不可用", "SERVER", { retryable: true })
    }
  }
  class OkLlm extends LlmAdapter {
    async *stream() {
      llmCalls += 1
      yield {
        type: "text-delta",
        index: 0,
        text: JSON.stringify({ answers: { mood: { type: "noul", noul: 0.9 } } }),
      }
      yield { type: "finish", reason: { kind: "stop" } }
    }
  }
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(JevRuntime)
  ctx.jev.registerAdapter("typesafe", new FlakyJev())
  ctx.llm.registerAdapter("fake", new OkLlm())
  await ctx.plugin(JevLlmPlugin, { provider: "llm", llmProvider: "fake", llmModel: "m" })
  ctx.jev.registerChain("main", [{ provider: "typesafe", model: "x" }, { provider: "llm", model: "m" }])
  t.after(() => ctx.fiber.dispose())
  const result = await ctx.jev.invoke("state", questions, { provider: "main" })
  assert.equal(result.answers.mood.noul, 0.9)
  assert.equal(llmCalls, 1)
})

test("同一 JevLlmPlugin 类可注册多个 LLM 兜底 provider", async (t) => {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(JevRuntime)
  ctx.llm.registerAdapter(
    "small",
    new TextLlm(JSON.stringify({ answers: { mood: { type: "noul", noul: 0.2 } } })),
  )
  ctx.llm.registerAdapter(
    "big",
    new TextLlm(JSON.stringify({ answers: { mood: { type: "noul", noul: 0.8 } } })),
  )
  await ctx.plugin(JevLlmPlugin, { provider: "llm-small", llmProvider: "small" })
  await ctx.plugin(JevLlmPlugin, { provider: "llm-big", llmProvider: "big" })
  t.after(() => ctx.fiber.dispose())

  const simple = await ctx.jev.invoke("state", questions, { provider: "llm-small", model: "small" })
  const complex = await ctx.jev.invoke("state", questions, { provider: "llm-big", model: "big" })
  assert.equal(simple.answers.mood.noul, 0.2)
  assert.equal(complex.answers.mood.noul, 0.8)
  assert.deepEqual(ctx.jev.listProviders().map((info) => info.id), ["llm-small", "llm-big"])
})
