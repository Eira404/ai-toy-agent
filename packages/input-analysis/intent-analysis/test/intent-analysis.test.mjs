import assert from "node:assert/strict"
import test from "node:test"
import { Context } from "cordis"
import { AgentService } from "toy-agent"
import { AgentLoop } from "toy-agent-loop"
import { ToyIntentAnalysis } from "toy-intent-analysis"
import { LlmAdapter, LlmRuntime } from "toy-llm"
import { SessionData } from "toy-session-data"
import { ToySession } from "toy-session"
import { ToolRegistry } from "toy-tools"

// 有 responseFormat 的调用是意图分析的 JSON Schema 调用，返回目录内的 JSON；否则是主循环回答。
class FakeModel extends LlmAdapter {
  async *stream({ responseFormat }) {
    if (responseFormat !== undefined) {
      yield {
        type: "text-delta",
        index: 0,
        text: JSON.stringify({ intent: "chitchat", confidence: 0.9 }),
      }
    } else {
      yield { type: "text-delta", index: 0, text: "你好，有什么可以帮你？" }
    }
    yield { type: "finish", reason: { kind: "stop" } }
  }
}

test("intent-analysis 注册到 preprocessing，结果进入 preprocessing.data", async () => {
  const ctx = new Context()
  await ctx.plugin(SessionData)
  await ctx.plugin(ToySession)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(ToolRegistry)
  await ctx.plugin(AgentService)
  await ctx.plugin(AgentLoop, { provider: "local", model: "demo" })
  await ctx.plugin(ToyIntentAnalysis, { provider: "local", model: "demo" })
  ctx.llm.registerAdapter("local", new FakeModel())

  try {
    const sessionId = await ctx.session.createSession({ userId: "u1", deviceId: "d1" })
    const { result } = await ctx.session.runTurn(sessionId, { message: { text: "你好" } })

    assert.equal(result.text, "你好，有什么可以帮你？")
    assert.deepEqual(result.preprocessing.data.intent, { intent: "chitchat", confidence: 0.9 })
  } finally {
    await ctx.fiber.dispose()
  }
})
