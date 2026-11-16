/* global console */
import { Context } from "cordis"
import { AgentService } from "toy-agent"
import { AgentLoop } from "toy-agent-loop"
import { AgentBackendService } from "toy-backend-agent"
import { HttpServer } from "toy-backend-http"
import { LlmAdapter, LlmRuntime } from "toy-llm"
import { SessionData } from "toy-session-data"
import { ToySession } from "toy-session"
import { ToolRegistry } from "toy-tools"

class LocalModel extends LlmAdapter {
  async *stream() {
    yield { type: "text-delta", index: 0, text: "你好" }
    yield { type: "text-delta", index: 0, text: "，有什么可以帮你？" }
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
await ctx.plugin(HttpServer, { host: "127.0.0.1", port: 3000 })
await ctx.plugin(AgentBackendService)
await ctx.http.ready
ctx.llm.registerAdapter("local", new LocalModel())

const base = `http://127.0.0.1:${ctx.http.address().port}`
console.log("backend server listening on", base)

try {
  const created = await (
    await fetch(`${base}/agentBackend/createSession`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: "u1", deviceId: "d1" }),
    })
  ).json()
  const sessionId = created.data
  console.log("sessionId =", sessionId)

  // 流式：SSE 逐事件输出
  const stream = await fetch(`${base}/agentBackend/runTurnStream/${sessionId}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: { text: "你好" } }),
  })
  const events = []
  for (const block of (await stream.text()).split("\n\n")) {
    const line = block.split("\n").find((l) => l.startsWith("data: "))
    if (line !== undefined) {
      events.push(JSON.parse(line.slice(6)))
    }
  }
  console.log(
    "SSE events =",
    events.map((e) => e.type),
  )
  console.log("final text =", events.find((e) => e.type === "complete")?.result.text)
} finally {
  await ctx.fiber.dispose()
}
