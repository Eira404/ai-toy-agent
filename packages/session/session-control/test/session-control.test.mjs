import assert from "node:assert/strict"
import test from "node:test"
import { Context } from "cordis"
import { AgentService } from "toy-agent"
import { AgentLoop } from "toy-agent-loop"
import { LlmAdapter, LlmRuntime } from "toy-llm"
import { SessionControl } from "toy-session-control"
import { SessionData } from "toy-session-data"
import { ToySession } from "toy-session"
import { ToolRegistry } from "toy-tools"

class FarewellModel extends LlmAdapter {
  async *stream({ messages }) {
    if (!messages.some(({ role }) => role === "tool")) {
      // 用户说再见 → 调用 close_session 工具
      yield {
        type: "tool-call-delta",
        index: 0,
        id: "c1",
        name: "close_session",
        argumentsDelta: "{}",
      }
      yield { type: "finish", reason: { kind: "tool-calls" } }
      return
    }
    // 收到工具返回的告别指令 → 生成道别语
    yield { type: "text-delta", index: 0, text: "再见，下次见！" }
    yield { type: "finish", reason: { kind: "stop" } }
  }
}

test("用户说再见 → LLM 调 close_session → 本轮道别 → 会话关闭", async () => {
  const ctx = new Context()
  await ctx.plugin(SessionData)
  await ctx.plugin(ToySession)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(ToolRegistry)
  await ctx.plugin(AgentService)
  await ctx.plugin(AgentLoop, { provider: "local", model: "demo" })
  await ctx.plugin(SessionControl)
  ctx.llm.registerAdapter("local", new FarewellModel())

  try {
    const sessionId = await ctx.session.createSession({ userId: "u1", deviceId: "d1" })
    const { result } = await ctx.session.runTurn(sessionId, { message: { text: "再见" } })

    // 当前 Turn 正常跑完，模型输出了道别语。
    assert.equal(result.text, "再见，下次见！")

    // 关闭动作挂到本轮结束后；让 pending 的关闭微任务/宏任务跑完。
    await new Promise((resolve) => setImmediate(resolve))
    // 会话已进入 closing/closed，后续 turn 会被拒绝。
    await assert.rejects(ctx.session.runTurn(sessionId, { message: { text: "你好" } }))
  } finally {
    await ctx.fiber.dispose()
  }
})
