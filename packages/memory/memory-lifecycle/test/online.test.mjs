import assert from "node:assert/strict"
import test from "node:test"
import { Context, Service } from "cordis"
import { JevRuntime, JevAdapter } from "toy-jev"
import {
  MemoryOnline,
  buildGateState,
  readMemorySpaceId,
  scopeFor,
  memoryExtractSection,
} from "../lib/index.js"

/** 固定返回指定 choice 的 JEV 替身。 */
class FakeJevAdapter extends JevAdapter {
  constructor(choice) {
    super()
    this.choice = choice
  }

  async invoke(request) {
    const choice = request.questions.memoryIntent.type === "choice" ? this.choice : "implicit"
    return {
      answers: {
        memoryIntent: {
          type: "choice",
          choice,
          confidence: 0.9,
          probabilities: { explicit: 0.9, implicit: 0.1 },
        },
      },
      model: "fake",
    }
  }
}

class FakeSession extends Service {
  constructor(ctx) {
    super(ctx, "session")
    this.preprocessing = { register: (p) => { this.spaceNode = p; return () => {} } }
  }
}

class FakeAgentLoop extends Service {
  constructor(ctx) {
    super(ctx, "agentLoop")
    this.preprocessing = { register: (p) => { this.gateNode = p; return () => {} } }
  }
}

class FakeMemorySpace extends Service {
  constructor(ctx) {
    super(ctx, "memorySpace")
  }

  async resolveMemorySpace() {
    return "space1"
  }
}

class FakeMemoryWrite extends Service {
  constructor(ctx) {
    super(ctx, "memoryWrite")
    this.extracted = null
  }

  async extract(input, wait) {
    this.extracted = { input, wait }
    return { kind: "written", records: [{}, {}], attempts: 1 }
  }
}

async function setup(choice) {
  const ctx = new Context()
  const fibers = []
  fibers.push(await ctx.plugin(JevRuntime))
  ctx.jev.registerAdapter("fake-adapter", new FakeJevAdapter(choice))
  ctx.jev.registerChain("fake", [{ provider: "fake-adapter", model: "m" }])
  fibers.push(await ctx.plugin(FakeSession))
  fibers.push(await ctx.plugin(FakeAgentLoop))
  fibers.push(await ctx.plugin(FakeMemorySpace))
  fibers.push(await ctx.plugin(FakeMemoryWrite))
  fibers.push(await ctx.plugin(MemoryOnline, { provider: "fake" }))
  return {
    ctx,
    async dispose() {
      for (const fiber of fibers.reverse()) {
        await fiber.dispose()
      }
    },
  }
}

function turnContext(message) {
  return {
    session: {
      sessionId: "s1",
      userId: "u1",
      payload: { preprocessing: { "memory-space": { memorySpaceId: "space1" } } },
    },
    turn: { turnId: "t1" },
    message,
    history: [],
    signal: undefined,
  }
}

test("buildGateState 组合当前消息与前几轮对话", () => {
  const state = buildGateState({
    message: "记住我喜欢吃苹果",
    history: [{ role: "user", content: "你好" }],
  })
  assert.equal(state, "上一轮用户：你好\n当前用户：记住我喜欢吃苹果")
})

test("readMemorySpaceId / scopeFor 解析 Session payload", () => {
  assert.equal(
    readMemorySpaceId({ preprocessing: { "memory-space": { memorySpaceId: "space1" } } }),
    "space1",
  )
  assert.equal(readMemorySpaceId({}), null)
  assert.equal(readMemorySpaceId({ preprocessing: {} }), null)
  assert.deepEqual(
    scopeFor({ userId: "u1", payload: { preprocessing: { "memory-space": { memorySpaceId: "s" } } } }),
    { userId: "u1", memorySpaceId: "s" },
  )
  assert.equal(scopeFor({ userId: "u1", payload: {} }), null)
})

test("memoryExtractSection 渲染三态", () => {
  const section = memoryExtractSection()
  const explicit = section.render({
    preprocessing: { data: { "memory-gate": { explicit: true, available: true, extract: null, count: 0 } } },
  })
  assert.match(explicit, /memory_write/)
  const written = section.render({
    preprocessing: { data: { "memory-gate": { explicit: false, available: true, extract: "written", count: 2 } } },
  })
  assert.match(written, /2 条记忆/)
  const empty = section.render({
    preprocessing: { data: { "memory-gate": { explicit: false, available: true, extract: "empty", count: 0 } } },
  })
  assert.match(empty, /不要声称/)
})

test("JEV 门控 explicit：不提取，返回 explicit 结果", async () => {
  const app = await setup("explicit")
  try {
    const gate = await app.ctx.memoryOnline.analyze({ message: "记住我喜欢吃苹果", history: [] })
    assert.equal(gate.memoryIntent, "explicit")

    const result = await app.ctx.agentLoop.gateNode.process(turnContext("记住我喜欢吃苹果"))
    assert.deepEqual(result, { explicit: true, available: true, extract: null, count: 0 })
    assert.equal(app.ctx.memoryWrite.extracted, null)
  } finally {
    await app.dispose()
  }
})

test("JEV 门控 implicit：自行提取并保证落库", async () => {
  const app = await setup("implicit")
  try {
    const gate = await app.ctx.memoryOnline.analyze({ message: "我喜欢吃苹果", history: [] })
    assert.equal(gate.memoryIntent, "implicit")

    const result = await app.ctx.agentLoop.gateNode.process(turnContext("我喜欢吃苹果"))
    assert.deepEqual(result, { explicit: false, available: true, extract: "written", count: 2 })
    assert.equal(app.ctx.memoryWrite.extracted.wait, "written")
    assert.equal(app.ctx.memoryWrite.extracted.input.scope.memorySpaceId, "space1")
  } finally {
    await app.dispose()
  }
})
