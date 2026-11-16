/* global console */
import { Context } from "cordis"
import { AgentService } from "toy-agent"
import { AgentLoop, SystemPromptAssembler } from "toy-agent-loop"
import { LlmAdapter, LlmRuntime } from "toy-llm"
import { SessionData } from "toy-session-data"
import { ToySession } from "toy-session"
import { ToolRegistry } from "toy-tools"

class LocalModel extends LlmAdapter {
  async *stream({ messages }) {
    const last = messages.at(-1)
    if (last?.role === "tool") {
      yield { type: "text-delta", index: 0, text: "已查询到北京今天晴朗。" }
      yield { type: "finish", reason: { kind: "stop" } }
      return
    }
    if (messages.some(({ role }) => role === "tool") === false && last?.role === "user") {
      yield { type: "tool-call-delta", index: 0, id: "call-1", name: "weather" }
      yield { type: "tool-call-delta", index: 0, argumentsDelta: "{\"city\":\"北京\"}" }
      yield { type: "finish", reason: { kind: "tool-calls" } }
      return
    }
    yield { type: "text-delta", index: 0, text: "你好，有什么可以帮你？" }
    yield { type: "finish", reason: { kind: "stop" } }
  }
}

const ctx = new Context()
await ctx.plugin(SessionData)
await ctx.plugin(ToySession)
await ctx.plugin(LlmRuntime)
await ctx.plugin(ToolRegistry)
await ctx.plugin(AgentService)
await ctx.plugin(AgentLoop, { provider: "local", model: "demo" })
await ctx.plugin(SystemPromptAssembler)

const unregisterModel = ctx.llm.registerAdapter("local", new LocalModel())
const unregisterTool = ctx.tools.register({
  name: "weather",
  description: "查询城市天气",
  parameters: {
    type: "object",
    required: ["city"],
    properties: { city: { type: "string" } },
  },
  execute: ({ city }) => ({ city, weather: "晴朗" }),
})

const unregisterPersona = ctx.systemPrompt.registerSection({
  name: "persona",
  order: 100,
  render: () => "你是玩具设备中的中文助手。",
})

// 观察事件流：当前接收器把流收成最终结果，未来 gRPC 直接消费同一份事件。
// 注册两个预处理节点，演示共享 state 的读与写。
const unregisterIntent = ctx.agentLoop.preprocessing.register({
  name: "intent",
  process: ({ message, state }) => {
    state.intent = message.includes("天气") ? "weather" : "chitchat"
    return { intent: state.intent }
  },
})
const unregisterEmotion = ctx.agentLoop.preprocessing.register({
  name: "emotion",
  dependsOn: ["intent"],
  process: ({ state }) => {
    // 声明 dependsOn 后，intent 已完成，其写入对当前节点可见。
    state.emotion = state.intent === "weather" ? "curious" : "neutral"
    return { emotion: state.emotion }
  },
})

const unregisterPost = ctx.agentLoop.nonBlockingPost.register({
  name: "summary",
  process: ({ text }) => {
    console.log("[nonblocking post] answer length =", text.length)
  },
})

try {
  const sessionId = await ctx.session.createSession({ userId: "u1", deviceId: "d1" })
  const { result } = await ctx.session.runTurn(sessionId, { message: { text: "北京天气怎么样？" } })
  console.log("result.text =", result.text)
  console.log("preprocessing.data =", result.preprocessing.data)
  console.log("preprocessing.state =", result.preprocessing.state)
  await ctx.agentLoop.waitForIdle()

  const history = ctx.sessionData.agent.getHistory(sessionId)
  console.log(
    "events =",
    history.turns.at(-1)?.events.map(({ eventType }) => eventType),
  )

  await ctx.session.requestClose(sessionId)
  await ctx.session.waitForPostprocessing()
} finally {
  unregisterPost()
  unregisterEmotion()
  unregisterIntent()
  unregisterPersona()
  unregisterTool()
  unregisterModel()
  await ctx.fiber.dispose()
}
