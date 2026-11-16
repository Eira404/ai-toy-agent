/* global console */
import assert from "node:assert/strict"
import { Context } from "cordis"
import { LlmRuntime } from "toy-llm"
import { MemoryValue, ValueEngine, decodeValueState } from "../lib/index.js"
import { ExampleDaily, ExampleFeedback, ScriptedAdapter } from "./support.mjs"

// 这些是预设模型答案，仅演示代码链路，不代表真实语义判断效果。
const adapter = new ScriptedAdapter((request) => {
  switch (request.responseFormat.name) {
    case "memory_value_importance":
      return { importance: "normal", reason: "普通、可持续使用的咖啡偏好。" }
    case "memory_value_feedback":
      return {
        primaryFeedbackType: "confirmed",
        reason: "用户在第 2 轮明确确认了咖啡偏好。",
        signals: [{ feedbackType: "confirmed", evidenceTurnNos: [2], reason: "用户明确说对。" }],
      }
    case "memory_value_content_change":
      return { changeType: "supplemented", reason: "补充了浅烘豆偏好。" }
    default:
      throw new Error(`未知示例任务 ${request.responseFormat.name}`)
  }
})

const ctx = new Context()
const fibers = []
let unregisterModel
try {
  fibers.push(await ctx.plugin(LlmRuntime))
  unregisterModel = ctx.llm.registerAdapter("example", adapter)
  // 实际应用先挂载真实 MemoryFeedback、MemoryDaily；本例只需要它们的注册契约。
  fibers.push(await ctx.plugin(ExampleFeedback))
  fibers.push(await ctx.plugin(ExampleDaily))
  fibers.push(
    await ctx.plugin(MemoryValue, {
      llmProvider: "example",
      llmModel: "scripted",
    }),
  )
  const engine = ctx.memoryValue
  assert.equal(ctx.memoryFeedback.engine, ctx.memoryDaily.engine)
  assert.ok(ctx.memoryFeedback.engine instanceof ValueEngine)

  // 1. 新单元初始化：模型只选择重要性，数值由旧算法生成；此时没有衰减。
  const [initial] = await engine.initialize([
    {
      unitType: "overview",
      domain: "self",
      title: "咖啡偏好",
      body: "用户喜欢冰美式。",
    },
  ])
  // 2. 为了展示曲线，本例主动推进 3 个周期；周期不是自然日。
  let old = initial
  for (let cycle = 0; cycle < 3; cycle++) {
    old = engine.decay(old)
  }
  // 3. 构造一次实际召回快照。overview 保留 overviewBody 字段，不在收尾时重查 Long。
  const unit = {
    unitType: "overview",
    unitId: "coffee",
    blockId: "coffee",
    recalledContent: { title: "咖啡偏好", summary: "喜欢冰美式", overviewBody: "用户喜欢冰美式。" },
  }
  // 4. 态度判断只产生反馈，尚未改变 old 的数值。召回当轮助手回答仅用于理解指代。
  const feedback = await engine.judgeSession({
    ...unit,
    recallTurnNos: [1],
    recallSnapshots: [{ ...unit, turnNo: 1, turnId: "turn-1" }],
    recallAssistantTurns: [{ turnNo: 1, assistantText: "你喜欢冰美式。" }],
    relevantTurns: [{ turnNo: 2, userText: "对，我就是喜欢冰美式。", assistantText: "好的。" }],
  })
  // 5. R0 应用反馈强化，不衰减；不要手工构造空的 judgementData 代替 judgeSession 产物。
  const r0 = engine.settle({ state: old, judgements: [feedback] })
  // 6. R7 也从 old 出发，不从 r0 继续强化。该契约的概述正文统一叫 body，必须 await。
  const r7 = await engine.reinforceUpdated({
    state: old,
    oldContent: {
      unitType: "overview",
      title: "咖啡偏好",
      summary: "喜欢冰美式",
      body: "用户喜欢冰美式。",
    },
    newContent: {
      unitType: "overview",
      title: "咖啡偏好",
      summary: "喜欢冰美式和浅烘豆",
      body: "用户喜欢冰美式，偏好浅烘豆。",
    },
  })
  // 7. 返回被选中的完整分支，不把两路增益相加；取大后只统一衰减一次。
  const best = engine.max(engine.max(old, r0), r7)
  const final = engine.decay(best)
  console.log("本地假模型示例：", feedback.feedbackType)
  console.table(
    [
      ["初始化", initial],
      ["衰减 3 周期", old],
      ["反馈强化 R0", r0],
      ["正文强化 R7", r7],
      ["取大再衰减 1 周期", final],
    ].map(([phase, state]) => {
      // 调试/展示时才解码内部数值；对外生命周期通过 engine.lifecycle 获取。
      const data = decodeValueState(state)
      return {
        phase,
        I: data.intrinsicImportance,
        S: data.consolidationStrength.toFixed(4),
        P: data.peakValue.toFixed(4),
        A: data.activityCycles,
        V: data.currentValue.toFixed(4),
        lifecycle: engine.lifecycle(state),
      }
    }),
  )

  // 8. 从未强化的 initial 单独演示归档；观察态可恢复，已归档状态为终态。
  let archived = initial
  let cycles = 0
  while (engine.lifecycle(archived) !== "archived" && cycles < 1000) {
    archived = engine.decay(archived)
    cycles++
  }
  assert.equal(engine.lifecycle(archived), "archived")
  console.log(`没有新反馈的 normal 单元在第 ${cycles} 个有效周期归档；周期不是天。`)
} finally {
  // 先卸载价值插件，注销两侧引擎注册，再卸载它依赖的服务。
  for (const fiber of fibers.reverse()) {
    await fiber.dispose()
  }
  unregisterModel?.()
}
