/* global AbortController, structuredClone */
import assert from "node:assert/strict"
import test from "node:test"
import { Context } from "cordis"
import { LlmAdapter, LlmRuntime } from "toy-llm"
import { ToolRegistry } from "toy-tools"

const scope = { userId: "u", deviceId: "d", sessionId: "s", turnId: "t" }
const context = { scope, providerCapabilities: { functionTools: true, builtinTools: [] } }
const shanghai = JSON.stringify({ city: "上海" })
const parameters = {
  type: "object",
  required: ["city"],
  additionalProperties: false,
  properties: { city: { type: "string" } },
}

function call(raw, name = "weather") {
  return { type: "tool-call", id: "call-1", name, arguments: raw }
}

async function setup(t) {
  const ctx = new Context()
  await ctx.plugin(ToolRegistry)
  t.after(() => ctx.fiber.dispose())
  return ctx
}

test("快照隔离工具定义、能力和 Handler，校验失败不会执行工具", async (t) => {
  const ctx = await setup(t)
  const schema = structuredClone(parameters)
  let calls = 0
  const release = ctx.tools.register({
    name: "weather",
    description: "查询天气",
    parameters: schema,
    isAvailable: ({ deviceId }) => deviceId === "d",
    execute(args, execution) {
      calls += 1
      assert.equal(execution.userId, scope.userId)
      assert.equal(execution.deviceId, scope.deviceId)
      assert.equal(execution.sessionId, scope.sessionId)
      assert.equal(execution.turnId, scope.turnId)
      assert.equal(execution.toolCallId, "call-1")
      assert.equal(typeof execution.record, "function")
      return { city: args.city, result: "sunny" }
    },
  })
  assert.throws(
    () =>
      ctx.tools.register({
        name: "weather",
        description: "重复",
        parameters,
        execute: () => undefined,
      }),
    { code: "DUPLICATE_TOOL" },
  )
  assert.throws(
    () =>
      ctx.tools.register({
        name: "bad",
        description: "错误",
        parameters: { type: "string" },
        execute: () => undefined,
      }),
    { code: "INVALID_SCHEMA" },
  )
  schema.properties.city.type = "number"
  const tools = ctx.tools.resolve(context)
  assert.equal(tools.schemas[0].parameters.properties.city.type, "string")
  assert.equal(
    ctx.tools.resolve({ ...context, providerCapabilities: { functionTools: false } }).schemas
      .length,
    0,
  )
  assert.equal(
    ctx.tools.resolve({ ...context, scope: { ...scope, deviceId: "different" } }).schemas.length,
    0,
  )
  release()
  assert.deepEqual(ctx.tools.resolve(context).schemas, [])
  assert.equal((await tools.execute(call("broken"))).error.phase, "parse")
  assert.equal((await tools.execute(call(JSON.stringify({ city: 7 })))).error.phase, "validation")
  assert.equal((await tools.execute(call("{}", "another"))).error.phase, "resolution")
  assert.equal(calls, 0)
  assert.deepEqual(await tools.execute(call(shanghai)), {
    toolCallId: "call-1",
    content: JSON.stringify({ city: "上海", result: "sunny" }),
    isError: false,
  })
  assert.equal(calls, 1)
})

test("将当前 Turn 的原始 payload 传给 isAvailable，并按本次判断固定快照", async (t) => {
  const ctx = await setup(t)
  const received = []
  ctx.tools.register({
    name: "weather",
    description: "查询天气",
    parameters,
    isAvailable(toolScope, payload) {
      assert.deepEqual(toolScope, scope)
      received.push(payload)
      return payload.allowWeather === true
    },
    execute: () => "sunny",
  })

  const payload = { allowWeather: true, metadata: new Map([["source", "turn"]]) }
  const allowed = ctx.tools.resolve({ ...context, payload })
  assert.equal(received[0], payload)
  assert.deepEqual(
    allowed.schemas.map(({ name }) => name),
    ["weather"],
  )

  const denied = ctx.tools.resolve({ ...context, payload: { allowWeather: "true" } })
  assert.deepEqual(denied.schemas, [])
  assert.deepEqual(ctx.tools.resolve(context).schemas, [])
  assert.deepEqual(received[2], {})
  assert.equal((await allowed.execute(call(shanghai))).isError, false)
  assert.equal((await denied.execute(call(shanghai))).error.phase, "resolution")
})

test("普通工具错误作为结果返回，取消沿信号向上抛出", async (t) => {
  const ctx = await setup(t)
  const controller = new AbortController()
  const reason = new Error("stop")
  ctx.tools.register({
    name: "weather",
    description: "查询天气",
    parameters,
    execute(_input, { signal }) {
      if (signal !== undefined) {
        assert.equal(signal, controller.signal)
        controller.abort(reason)
      }
      throw new Error("internal details")
    },
  })
  const tools = ctx.tools.resolve(context)
  const result = await tools.execute(call(shanghai))
  assert.equal(result.error.phase, "execution")
  assert.equal(result.content.includes("internal details"), false)
  await assert.rejects(
    tools.execute(call(shanghai), { signal: controller.signal }),
    (error) => error === reason,
  )
})

test("统一协议支持模型请求工具、按快照执行并回传给模型", async (t) => {
  const ctx = await setup(t)
  await ctx.plugin(LlmRuntime)
  ctx.tools.register({
    name: "weather",
    description: "查询天气",
    parameters,
    execute: ({ city }) => `${city}晴天`,
  })
  class LocalModel extends LlmAdapter {
    async *stream(request) {
      const last = request.messages.at(-1)
      if (last?.role === "tool") {
        assert.equal(last.toolCallId, "call-1")
        assert.equal(last.content[0].text, "上海晴天")
        yield { type: "text-delta", index: 0, text: last.content[0].text }
        yield { type: "finish", reason: { kind: "stop" } }
        return
      }
      assert.equal(request.tools[0].name, "weather")
      yield { type: "block-end", index: 0, block: call(shanghai) }
      yield { type: "finish", reason: { kind: "tool-calls" } }
    }
  }
  ctx.llm.registerAdapter("local", new LocalModel())
  const options = { provider: "local", model: "demo", messages: [] }
  const tools = ctx.tools.resolve({
    scope,
    providerCapabilities: ctx.llm.providerInfo("local").capabilities,
  })
  const first = await ctx.llm.generate({ ...options, tools: tools.schemas })
  assert.equal(first.finish.kind, "tool-calls")
  const output = await tools.execute(first.content[0])
  const final = await ctx.llm.generate({
    ...options,
    messages: [
      { role: "assistant", content: first.content },
      {
        role: "tool",
        toolCallId: output.toolCallId,
        content: [{ type: "text", text: output.content }],
      },
    ],
  })
  assert.deepEqual(final, {
    content: [{ type: "text", text: "上海晴天" }],
    finish: { kind: "stop" },
  })
})

test("工具可用 context.record 记录只持久化、不暴露给模型的数据", async (t) => {
  const ctx = await setup(t)
  ctx.tools.register({
    name: "retrieve",
    description: "检索记忆",
    parameters: { type: "object", properties: {} },
    execute(_args, { record }) {
      record({ ids: ["a", "b"] })
      return "命中两条记忆"
    },
  })
  const tools = ctx.tools.resolve(context)
  const result = await tools.execute(call("{}", "retrieve"))
  assert.equal(result.content, "命中两条记忆")
  assert.deepEqual(result.data, { ids: ["a", "b"] })
})

test("内置工具按 Provider 能力与 isAvailable 双重过滤注入", async (t) => {
  const ctx = await setup(t)
  ctx.tools.registerBuiltin({ name: "web_search", description: "搜索网络" })
  ctx.tools.registerBuiltin({
    name: "image_gen",
    description: "生成图片",
    isAvailable: (_scope, payload) => payload.allowImage === true,
  })
  ctx.tools.registerBuiltin({ name: "unsupported", description: "不被 Provider 支持" })

  const capabilities = { functionTools: true, builtinTools: ["web_search", "image_gen"] }
  const allowed = ctx.tools.resolve({
    scope,
    payload: { allowImage: true },
    providerCapabilities: capabilities,
  })
  assert.deepEqual(
    allowed.schemas.filter(({ kind }) => kind === "builtin").map(({ name }) => name),
    ["web_search", "image_gen"],
  )

  const denied = ctx.tools.resolve({
    scope,
    payload: { allowImage: false },
    providerCapabilities: capabilities,
  })
  assert.deepEqual(
    denied.schemas.filter(({ kind }) => kind === "builtin").map(({ name }) => name),
    ["web_search"],
  )
})
