import assert from "node:assert/strict"
import test from "node:test"
import { Context } from "cordis"
import { AgentService } from "toy-agent"
import { SessionData } from "toy-session-data"
import { ToySession } from "toy-session"

/** 构造只挂载 AgentService 依赖链的上下文：SessionData → ToySession → AgentService。 */
async function makeAgent() {
  const ctx = new Context()
  await ctx.plugin(SessionData)
  await ctx.plugin(ToySession)
  await ctx.plugin(AgentService)
  return ctx
}

/** 返回按给定顺序产出事件的假 runner，忽略输入。 */
function fakeRunner(events) {
  return {
    stream: async function* () {
      yield* events
    },
  }
}

/** 构造一个合法的 complete 事件，作为 run() 的终止与结果来源。 */
function completeEvent() {
  return {
    type: "complete",
    result: {
      turnId: "t1",
      text: "你好",
      content: [{ type: "text", text: "你好" }],
      preprocessing: { items: [], data: {}, state: {} },
      blockingPost: { items: [], data: {}, state: {} },
      steps: [],
    },
  }
}

test("run：通过 input.onEvent 按序转发事件，仍返回完整结果", async () => {
  const ctx = await makeAgent()
  const events = [
    { type: "run-start", sessionId: "s1", turnId: "t1" },
    { type: "assistant-delta", step: 0, channel: "text", delta: "你好" },
    completeEvent(),
  ]
  const seen = []
  const unregister = ctx.agent.registerRunner(fakeRunner(events))

  try {
    const result = await ctx.agent.run({ onEvent: (event) => seen.push(event.type) })
    assert.equal(result.text, "你好")
    assert.deepEqual(seen, ["run-start", "assistant-delta", "complete"])
  } finally {
    unregister()
    await ctx.fiber.dispose()
  }
})

test("run：未提供 onEvent 时正常返回结果", async () => {
  const ctx = await makeAgent()
  const unregister = ctx.agent.registerRunner(fakeRunner([completeEvent()]))

  try {
    const result = await ctx.agent.run({})
    assert.equal(result.text, "你好")
  } finally {
    unregister()
    await ctx.fiber.dispose()
  }
})
