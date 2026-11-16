import assert from "node:assert/strict"
import test from "node:test"
import { Context } from "cordis"
import { AgentService } from "toy-agent"
import { AgentLoop } from "toy-agent-loop"
import { AgentBackendService } from "toy-backend-agent"
import { HttpServer } from "toy-backend-http"
import { LlmAdapter, LlmRuntime } from "toy-llm"
import { SessionData } from "toy-session-data"
import { ToySession } from "toy-session"
import { ToolRegistry } from "toy-tools"

class EchoModel extends LlmAdapter {
  async *stream() {
    yield { type: "text-delta", index: 0, text: "你好，有什么可以帮你？" }
    yield { type: "finish", reason: { kind: "stop" } }
  }
}

class SlowModel extends LlmAdapter {
  started = false
  aborted = false

  async *stream({ signal }) {
    this.started = true
    yield { type: "text-delta", index: 0, text: "开始" }
    await new Promise((resolve) => {
      if (signal?.aborted) {
        this.aborted = true
        resolve()
        return
      }
      const onAbort = () => {
        this.aborted = true
        resolve()
      }
      signal?.addEventListener("abort", onAbort, { once: true })
      setTimeout(() => {
        signal?.removeEventListener("abort", onAbort)
        resolve()
      }, 5000)
    })
    yield { type: "finish", reason: { kind: "aborted", failure: { message: "已取消", code: "ABORTED" } } }
  }
}

/** 挂载 agent 后端门面所需的完整链路（内存模式 + 假模型 + HTTP 服务）。 */
async function makeBackend(model = new EchoModel()) {
  const ctx = new Context()
  await ctx.plugin(SessionData)
  await ctx.plugin(ToySession)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(ToolRegistry)
  await ctx.plugin(AgentService)
  await ctx.plugin(AgentLoop, { provider: "local", model: "demo" })
  await ctx.plugin(HttpServer, { port: 0 })
  await ctx.plugin(AgentBackendService)
  await ctx.http.ready
  ctx.llm.registerAdapter("local", model)
  return ctx
}

async function postJson(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
  return { status: res.status, json: await res.json() }
}

function parseSse(text) {
  return text
    .split("\n\n")
    .map((block) => block.trim())
    .filter((block) => block.length > 0)
    .map((block) => {
      const line = block.split("\n").find((l) => l.startsWith("data: "))
      return line === undefined ? null : JSON.parse(line.slice(6))
    })
    .filter((event) => event !== null)
}

async function waitUntil(fn, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (!fn()) {
    if (Date.now() > deadline) {
      throw new Error("waitUntil 超时")
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

test("门面进程内调用：createSession → runTurn → 读取 → 关闭", async () => {
  const ctx = await makeBackend()

  try {
    const sessionId = await ctx.agentBackend.createSession({ userId: "u1", deviceId: "d1" })
    const { result } = await ctx.agentBackend.runTurn(sessionId, { message: { text: "你好" } })
    assert.equal(result.text, "你好，有什么可以帮你？")

    await ctx.agentBackend.closeSession(sessionId)
    await ctx.agentBackend.waitForPostprocessing()
    assert.equal((await ctx.agentBackend.getSession(sessionId))?.status, "closed")
  } finally {
    await ctx.fiber.dispose()
  }
})

test("HTTP JSON：createSession → runTurn → getSession", async () => {
  const ctx = await makeBackend()
  const base = `http://127.0.0.1:${ctx.http.address().port}`

  try {
    const created = await postJson(`${base}/agentBackend/createSession`, {
      userId: "u1",
      deviceId: "d1",
    })
    assert.equal(created.status, 200)
    const sessionId = created.json.data

    const run = await postJson(`${base}/agentBackend/runTurn/${sessionId}`, {
      message: { text: "你好" },
    })
    assert.equal(run.json.data.result.text, "你好，有什么可以帮你？")

    const session = await (await fetch(`${base}/agentBackend/getSession/${sessionId}`)).json()
    assert.equal(session.data.status, "active")
  } finally {
    await ctx.fiber.dispose()
  }
})

test("HTTP SSE：runTurnStream 逐事件流式输出", async () => {
  const ctx = await makeBackend()
  const base = `http://127.0.0.1:${ctx.http.address().port}`

  try {
    const created = await postJson(`${base}/agentBackend/createSession`, {
      userId: "u1",
      deviceId: "d1",
    })
    const sessionId = created.json.data

    const res = await fetch(`${base}/agentBackend/runTurnStream/${sessionId}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: { text: "你好" } }),
    })
    assert.equal(res.headers.get("content-type"), "text/event-stream")

    const events = parseSse(await res.text())
    const types = events.map((event) => event.type)
    assert.ok(types.includes("run-start"))
    assert.ok(types.includes("assistant-delta"))
    assert.ok(types.includes("complete"))

    const complete = events.find((event) => event.type === "complete")
    assert.equal(complete.result.text, "你好，有什么可以帮你？")
  } finally {
    await ctx.fiber.dispose()
  }
})

test("HTTP 中断：客户端断开后模型收到取消信号", async () => {
  const model = new SlowModel()
  const ctx = await makeBackend(model)
  const base = `http://127.0.0.1:${ctx.http.address().port}`

  try {
    const created = await postJson(`${base}/agentBackend/createSession`, {
      userId: "u1",
      deviceId: "d1",
    })
    const sessionId = created.json.data

    const controller = new AbortController()
    await fetch(`${base}/agentBackend/runTurnStream/${sessionId}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: { text: "你好" } }),
      signal: controller.signal,
    })
    await waitUntil(() => model.started)
    controller.abort()
    await waitUntil(() => model.aborted)
    assert.equal(model.aborted, true)
  } finally {
    await ctx.fiber.dispose()
  }
})
