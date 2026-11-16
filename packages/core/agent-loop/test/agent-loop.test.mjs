import assert from "node:assert/strict"
import test from "node:test"
import { Context } from "cordis"
import { AgentService } from "toy-agent"
import { AgentLoop, SystemPromptAssembler } from "toy-agent-loop"
import { LlmAdapter, LlmRuntime } from "toy-llm"
import { SessionData } from "toy-session-data"
import { ToySession } from "toy-session"
import { ToolRegistry } from "toy-tools"

class TextModel extends LlmAdapter {
  async *stream() {
    yield { type: "text-delta", index: 0, text: "你好，有什么可以帮你？" }
    yield { type: "finish", reason: { kind: "stop" } }
  }
}

class ToolModel extends LlmAdapter {
  async *stream({ messages }) {
    if (!messages.some(({ role }) => role === "tool")) {
      yield {
        type: "tool-call-delta",
        index: 0,
        id: "call-1",
        name: "weather",
        argumentsDelta: '{"city":"北京"}',
      }
      yield { type: "finish", reason: { kind: "tool-calls" } }
      return
    }
    yield { type: "text-delta", index: 0, text: "北京晴朗。" }
    yield { type: "finish", reason: { kind: "stop" } }
  }
}

class CapturingModel extends LlmAdapter {
  constructor() {
    super()
    this.requests = []
  }

  async *stream({ messages }) {
    this.requests.push(messages)
    yield { type: "text-delta", index: 0, text: "收到。" }
    yield { type: "finish", reason: { kind: "stop" } }
  }
}

class RetrieveModel extends LlmAdapter {
  constructor() {
    super()
    this.requests = []
  }

  async *stream({ messages }) {
    this.requests.push(messages)
    if (!messages.some(({ role }) => role === "tool")) {
      yield {
        type: "tool-call-delta",
        index: 0,
        id: "c1",
        name: "retrieve_memory",
        argumentsDelta: '{"query":"我喜欢什么水果"}',
      }
      yield { type: "finish", reason: { kind: "tool-calls" } }
      return
    }
    yield { type: "text-delta", index: 0, text: "你喜欢苹果。" }
    yield { type: "finish", reason: { kind: "stop" } }
  }
}

async function makeContext(model) {
  const ctx = new Context()
  await ctx.plugin(SessionData)
  await ctx.plugin(ToySession)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(ToolRegistry)
  await ctx.plugin(AgentService)
  await ctx.plugin(AgentLoop, { provider: "local", model: "demo" })
  ctx.llm.registerAdapter("local", model)
  ctx.tools.register({
    name: "weather",
    description: "查询城市天气",
    parameters: {
      type: "object",
      required: ["city"],
      properties: { city: { type: "string" } },
    },
    execute: ({ city }) => ({ city, weather: "晴朗" }),
  })
  return ctx
}

test("文本轮：完成预处理、回答与非阻塞后处理", async () => {
  const ctx = await makeContext(new TextModel())
  const seen = []
  ctx.agentLoop.preprocessing.register({
    name: "intent",
    process: ({ message, state }) => {
      state.intent = message === "你好" ? "greeting" : "unknown"
      return { intent: state.intent }
    },
  })
  ctx.agentLoop.preprocessing.register({
    name: "emotion",
    dependsOn: ["intent"],
    process: ({ state }) => {
      // 依赖声明保证 intent 已完成，这里能读到它写进 state 的值。
      state.emotion = state.intent === "greeting" ? "happy" : "neutral"
      return { emotion: state.emotion }
    },
  })
  ctx.agentLoop.blockingPost.register({
    name: "commit",
    process: async ({ appendEvents }) => {
      await appendEvents([{ eventType: "turn_state", payload: { committed: true } }])
    },
  })
  ctx.agentLoop.nonBlockingPost.register({
    name: "note",
    process: ({ text }) => {
      seen.push(text)
    },
  })

  try {
    const sessionId = await ctx.session.createSession({ userId: "u1", deviceId: "d1" })
    const { result } = await ctx.session.runTurn(sessionId, { message: { text: "你好" } })

    assert.equal(result.text, "你好，有什么可以帮你？")
    assert.deepEqual(result.preprocessing.data.intent, { intent: "greeting" })
    assert.equal(result.preprocessing.state.intent, "greeting")
    assert.equal(result.preprocessing.state.emotion, "happy")
    assert.equal(result.blockingPost.items[0]?.name, "commit")
    assert.equal(result.steps.length, 1)

    await ctx.agentLoop.waitForIdle()
    assert.deepEqual(seen, ["你好，有什么可以帮你？"])

    const events = ctx.sessionData.agent.getHistory(sessionId).turns.at(-1).events
    assert.deepEqual(
      events.map(({ eventType }) => eventType),
      ["user_message", "assistant_message", "turn_state"],
    )
  } finally {
    await ctx.fiber.dispose()
  }
})

test("工具轮：先工具调用再回答，工具事件写入日志", async () => {
  const ctx = await makeContext(new ToolModel())

  try {
    const sessionId = await ctx.session.createSession({ userId: "u1", deviceId: "d1" })
    const { result } = await ctx.session.runTurn(sessionId, {
      message: { text: "北京天气怎么样？" },
    })

    assert.equal(result.text, "北京晴朗。")
    assert.equal(result.steps.length, 2)

    const events = ctx.sessionData.agent.getHistory(sessionId).turns.at(-1).events
    assert.deepEqual(
      events.map(({ eventType }) => eventType),
      ["user_message", "tool_call", "tool_result", "assistant_message"],
    )
  } finally {
    await ctx.fiber.dispose()
  }
})

test("缺少 provider/model 时拒绝本轮", async () => {
  const ctx = new Context()
  await ctx.plugin(SessionData)
  await ctx.plugin(ToySession)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(ToolRegistry)
  await ctx.plugin(AgentService)
  await ctx.plugin(AgentLoop)
  ctx.llm.registerAdapter("local", new TextModel())

  try {
    const sessionId = await ctx.session.createSession({ userId: "u1", deviceId: "d1" })
    await assert.rejects(
      ctx.session.runTurn(sessionId, { message: { text: "你好" } }),
      (error) => error?.code === "INVALID_REQUEST",
    )
  } finally {
    await ctx.fiber.dispose()
  }
})

test("SystemPromptAssembler 插件：片段进入 system，user 默认原文", async () => {
  const model = new CapturingModel()
  const ctx = await makeContext(model)
  await ctx.plugin(SystemPromptAssembler)
  const unregisterSection = ctx.systemPrompt.registerSection({
    name: "persona",
    order: 100,
    render: () => "你是可爱的小熊。",
  })

  try {
    const sessionId = await ctx.session.createSession({ userId: "u1", deviceId: "d1" })
    const { result } = await ctx.session.runTurn(sessionId, { message: { text: "你好" } })

    assert.equal(result.text, "收到。")
    const [messages] = model.requests
    assert.equal(messages[0]?.role, "system")
    assert.match(messages[0]?.content[0]?.text, /你是可爱的小熊/)
    assert.equal(messages[1]?.role, "user")
    assert.equal(messages[1]?.content[0]?.text, "你好")
  } finally {
    unregisterSection()
    await ctx.fiber.dispose()
  }
})

test("PromptSection：target 注入用户、name 覆盖默认 system/user", async () => {
  const model = new CapturingModel()
  const ctx = await makeContext(model)
  await ctx.plugin(SystemPromptAssembler)
  const unregisterSystem = ctx.systemPrompt.registerSection({
    name: "system",
    render: () => "覆盖后的系统指令",
  })
  const unregisterUser = ctx.systemPrompt.registerSection({
    name: "user",
    target: "user",
    render: ({ message }) => `【问题】${message}`,
  })
  const unregisterHint = ctx.systemPrompt.registerSection({
    name: "hint",
    target: "user",
    render: () => "请简洁回答",
  })

  try {
    const sessionId = await ctx.session.createSession({ userId: "u1", deviceId: "d1" })
    const { result } = await ctx.session.runTurn(sessionId, { message: { text: "你好" } })

    assert.equal(result.text, "收到。")
    const [messages] = model.requests
    assert.equal(messages[0]?.role, "system")
    assert.equal(messages[0]?.content[0]?.text, "覆盖后的系统指令")
    assert.equal(messages[1]?.role, "user")
    assert.equal(messages[1]?.content[0]?.text, "【问题】你好\n\n请简洁回答")
  } finally {
    unregisterHint()
    unregisterUser()
    unregisterSystem()
    await ctx.fiber.dispose()
  }
})

test("工具 record 的数据持久化到 tool_result 事件，但不进入模型", async () => {
  const model = new RetrieveModel()
  const ctx = await makeContext(model)
  ctx.tools.register({
    name: "retrieve_memory",
    description: "检索用户长期记忆",
    parameters: {
      type: "object",
      required: ["query"],
      properties: { query: { type: "string" } },
    },
    execute: async (_args, context) => {
      // 只持久化的数据：检索命中的记忆 id，模型不应看到
      context.record({ retrievedIds: ["m1", "m2"] })
      // 返回给模型的文本
      return "你喜欢苹果。"
    },
  })

  try {
    const sessionId = await ctx.session.createSession({ userId: "u1", deviceId: "d1" })
    const { result } = await ctx.session.runTurn(sessionId, {
      message: { text: "我喜欢什么水果？" },
    })

    assert.equal(result.text, "你喜欢苹果。")

    // 模型侧：工具结果只含文本，不含 id
    const toolMessage = model.requests.flat().find(({ role }) => role === "tool")
    assert.equal(toolMessage?.content[0]?.text, "你喜欢苹果。")
    assert.doesNotMatch(toolMessage?.content[0]?.text ?? "", /m1|m2/)

    // 事件侧：tool_result 持久化了 data（含 id）
    const events = ctx.sessionData.agent.getHistory(sessionId).turns.at(-1).events
    const toolResultEvent = events.find(({ eventType }) => eventType === "tool_result")
    assert.deepEqual(toolResultEvent?.payload.data, { retrievedIds: ["m1", "m2"] })
  } finally {
    await ctx.fiber.dispose()
  }
})

test("内置工具随 tools 发送：Provider 支持 + isAvailable 双重过滤", async () => {
  const model = new BuiltinModel()
  const ctx = new Context()
  await ctx.plugin(SessionData)
  await ctx.plugin(ToySession)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(ToolRegistry)
  await ctx.plugin(AgentService)
  await ctx.plugin(AgentLoop, { provider: "local", model: "demo" })
  ctx.llm.registerAdapter("local", model)
  ctx.tools.registerBuiltin({ name: "web_search", description: "获取实时网络信息" })
  ctx.tools.registerBuiltin({ name: "unsupported", description: "不支持的内置工具" })
  ctx.tools.registerBuiltin({
    name: "image_gen",
    description: "生成图片",
    isAvailable: (_scope, payload) => payload.policy?.allowImage === true,
  })
  ctx.agentLoop.preprocessing.register({
    name: "policy",
    process: ({ message }) => ({ allowImage: message.includes("画") }),
  })

  try {
    const sessionId = await ctx.session.createSession({ userId: "u1", deviceId: "d1" })
    await ctx.session.runTurn(sessionId, { message: { text: "帮我画一张图" } })

    const [{ tools }] = model.requests
    const builtin = tools.filter(({ kind }) => kind === "builtin")
    assert.deepEqual(
      builtin.map(({ name }) => name),
      ["web_search", "image_gen"],
    )

    model.requests = []
    await ctx.session.runTurn(sessionId, { message: { text: "你好" } })
    const [second] = model.requests
    const secondBuiltin = second.tools.filter(({ kind }) => kind === "builtin")
    assert.deepEqual(
      secondBuiltin.map(({ name }) => name),
      ["web_search"],
    )
  } finally {
    await ctx.fiber.dispose()
  }
})

class BuiltinModel extends LlmAdapter {
  constructor() {
    super()
    this.requests = []
  }

  providerInfo(provider) {
    return {
      id: provider,
      name: provider,
      protocol: "custom",
      capabilities: {
        functionTools: true,
        builtinTools: ["web_search", "image_gen"],
        jsonSchema: true,
        reasoning: true,
      },
    }
  }

  async *stream({ messages, tools }) {
    this.requests.push({ messages, tools })
    yield { type: "text-delta", index: 0, text: "收到。" }
    yield { type: "finish", reason: { kind: "stop" } }
  }
}
