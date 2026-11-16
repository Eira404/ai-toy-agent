import assert from "node:assert/strict"
import test from "node:test"
import { Context } from "cordis"
import { LlmRuntime } from "toy-llm"
import { MemoryValue, decodeValueState, ValueEngine } from "../lib/index.js"
import { ExampleDaily, ExampleFeedback, ScriptedAdapter } from "../examples/support.mjs"
import { runSettle } from "../../memory-daily/lib/stages/settle/index.js"
import { config, initial, makeEngine } from "./helpers.mjs"

test("Cordis 把同一个引擎注册到两侧，卸载注销，重新挂载正常", async () => {
  const ctx = new Context()
  const fibers = []
  let valueFiber
  let unregister
  try {
    fibers.push(await ctx.plugin(LlmRuntime))
    const adapter = new ScriptedAdapter(() => ({ importance: "high", reason: "重要事实。" }))
    unregister = ctx.llm.registerAdapter("fake", adapter)
    fibers.push(await ctx.plugin(ExampleFeedback))
    fibers.push(await ctx.plugin(ExampleDaily))
    valueFiber = await ctx.plugin(MemoryValue, config)
    assert.equal(ctx.memoryFeedback.engine, ctx.memoryDaily.engine)
    assert.ok(ctx.memoryFeedback.engine instanceof ValueEngine)
    const [state] = await ctx.memoryValue.initialize([
      { unitType: "overview", domain: "self", title: "t", body: "b" },
    ])
    assert.equal(decodeValueState(state).intrinsicImportance, 0.7)
    assert.equal(adapter.calls.length, 1)
    await valueFiber.dispose()
    valueFiber = undefined
    assert.equal(ctx.memoryFeedback.engine, null)
    assert.equal(ctx.memoryDaily.engine, null)
    valueFiber = await ctx.plugin(MemoryValue, config)
    assert.equal(ctx.memoryFeedback.engine, ctx.memoryDaily.engine)
  } finally {
    await valueFiber?.dispose()
    unregister?.()
    for (const fiber of fibers.reverse()) {
      await fiber.dispose()
    }
  }
})

test("Daily 注册失败时回滚已注册的 feedback，不留下半注册引擎", async () => {
  const ctx = new Context()
  const fibers = []
  let valueFiber
  try {
    fibers.push(await ctx.plugin(LlmRuntime))
    fibers.push(await ctx.plugin(ExampleFeedback))
    fibers.push(await ctx.plugin(ExampleDaily))
    const occupied = {}
    const release = ctx.memoryDaily.registerValueEngine(occupied)
    await assert.rejects(async () => {
      valueFiber = ctx.plugin(MemoryValue, config)
      await valueFiber
    }, /engine-already-registered/)
    assert.equal(ctx.memoryFeedback.engine, null)
    assert.equal(ctx.memoryDaily.engine, occupied)
    release()
  } finally {
    await valueFiber?.dispose()
    for (const fiber of fibers.reverse()) {
      await fiber.dispose()
    }
  }
})

test("Daily 概述和 detail 等待异步正文强化，再取大且只衰减一次", async () => {
  const { engine: scripted, calls } = makeEngine(async () => ({
    changeType: "supplemented",
    reason: "补充事实。",
  }))
  assert.ok(scripted instanceof ValueEngine)
  const state = scripted.decay(initial())
  const block = {
    blockId: "b1",
    domain: "self",
    title: "咖啡",
    aliases: [],
    summary: "旧摘要",
    overviewBody: "旧概述。",
    lifecycleStatus: "active",
    value: state,
    details: [
      {
        detailId: "d1",
        summary: "旧细节摘要",
        body: "旧细节。",
        lifecycleStatus: "active",
        value: state,
      },
    ],
  }
  const plan = {
    kind: "UPDATE",
    blockId: "b1",
    domain: "self",
    title: "咖啡",
    aliases: [],
    summary: "新摘要",
    overviewBody: "新概述，补充事实。",
    sourceFastIds: [],
    candidates: [],
    detailOps: [
      { kind: "UPDATE", detailId: "d1", summary: "新细节摘要", body: "新细节，补充事实。" },
    ],
  }
  const result = await runSettle(
    { valueEngine: scripted },
    { frozenLong: [block] },
    { reinforced: {}, skipped: [] },
    [{ verdict: "APPLY", plan }],
  )
  const settled = result.settled[0]
  assert.equal(calls.length, 2)
  assert.equal(decodeValueState(settled.overviewValue).activityCycles, 1)
  assert.equal(decodeValueState(settled.detailValues.d1.value).activityCycles, 1)
  assert.ok(
    decodeValueState(settled.overviewValue).consolidationStrength >
      decodeValueState(state).consolidationStrength,
  )
  assert.deepEqual(settled.overviewValue, settled.detailValues.d1.value)
})
