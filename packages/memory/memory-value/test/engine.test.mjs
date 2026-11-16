/* global AbortController */
import assert from "node:assert/strict"
import test from "node:test"
import {
  ForgettingEngine,
  ValueEngineError,
  decodeValueState,
  encodeValueState,
  JUDGEMENT_VERSION,
} from "../lib/index.js"
import { makeEngine, initial, feedbackOutput, judgeInput, contents } from "./helpers.mjs"

test("initialize 按输入顺序分类并初始化，空批次不调用模型", async () => {
  const { engine, calls } = makeEngine((request) => {
    const input = JSON.parse(request.messages.at(-1).content[0].text)
    return { importance: input.title === "关键约束" ? "core" : "low", reason: "按内容分类。" }
  })
  assert.deepEqual(await engine.initialize([]), [])
  assert.equal(calls.length, 0)
  const states = await engine.initialize([
    { unitType: "overview", domain: "self", title: "关键约束", body: "长期且关键的约束。" },
    { unitType: "detail", domain: "event", title: "临时事项", body: "临时信息。" },
  ])
  assert.deepEqual(
    states.map((state) => decodeValueState(state).intrinsicImportance),
    [1, 0.2],
  )
  assert.ok(calls.every((call) => call.responseFormat.name === "memory_value_importance"))
  await assert.rejects(
    () => engine.initialize([{ unitType: "overview", domain: "unknown", title: "t", body: "b" }]),
    (error) => error.code === "invalid-input",
  )
  assert.equal(calls.length, 2)
})

test("judgeSession 传入真实快照和语境，返回可用于 settle 的版本化反馈", async () => {
  const { engine, calls } = makeEngine(() => feedbackOutput())
  const input = judgeInput()
  const judgement = await engine.judgeSession(input)
  assert.equal(judgement.feedbackType, "confirmed")
  assert.equal(judgement.judgementVersion, JUDGEMENT_VERSION)
  assert.deepEqual(judgement.evidenceTurnNos, [2])
  const prompt = JSON.parse(calls[0].messages.at(-1).content[0].text)
  assert.deepEqual(prompt.recalledContent, input.recalledContent)
  assert.deepEqual(prompt.recallSnapshots, input.recallSnapshots)
  assert.deepEqual(prompt.recallAssistantTurns, input.recallAssistantTurns)
  let state = initial()
  for (let i = 0; i < 3; i++) {
    state = engine.decay(state)
  }
  const settled = decodeValueState(engine.settle({ state, judgements: [judgement] }))
  assert.equal(settled.activityCycles, 0)
  assert.ok(settled.currentValue > decodeValueState(state).currentValue)
  assert.equal(calls.length, 1) // settle/decay 纯数值，不再调用模型。
})

test("混合态度中的纠错覆盖正向主要态度，settle 不强化旧值", async () => {
  const output = feedbackOutput()
  output.signals.push({
    feedbackType: "corrected",
    evidenceTurnNos: [3],
    reason: "第 3 轮明确否定旧记忆。",
  })
  const { engine } = makeEngine(() => output)
  const input = judgeInput({
    relevantTurns: [
      { turnNo: 2, userText: "对。", assistantText: "好的。" },
      { turnNo: 3, userText: "不对，我刚才说错了。", assistantText: "明白。" },
    ],
  })
  const judgement = await engine.judgeSession(input)
  assert.equal(judgement.feedbackType, "corrected")
  assert.deepEqual(judgement.evidenceTurnNos, [3])
  assert.match(judgement.judgementData.reason, /明确否定/)
  const state = engine.decay(initial())
  assert.deepEqual(engine.settle({ state, judgements: [judgement] }), state)
})

test("没有后续用户表达时无需模型，助手表达不会产生确认", async () => {
  const { engine, calls } = makeEngine(() => {
    throw new Error("不应调用")
  })
  for (const relevantTurns of [
    [],
    [{ turnNo: 2, userText: "  ", assistantText: "用户肯定喜欢冰美式。" }],
  ]) {
    const judgement = await engine.judgeSession(judgeInput({ relevantTurns }))
    assert.equal(judgement.feedbackType, "no_user_signal")
    assert.deepEqual(judgement.evidenceTurnNos, [])
  }
  assert.equal(calls.length, 0)
})

test("显式无信号模型结果有效，不能凭空携带证据", async () => {
  const { engine } = makeEngine(() => feedbackOutput("no_user_signal"))
  const judgement = await engine.judgeSession(judgeInput())
  assert.equal(judgement.feedbackType, "no_user_signal")
  const invalid = makeEngine(() => ({
    ...feedbackOutput(),
    primaryFeedbackType: "no_user_signal",
  })).engine
  await assert.rejects(
    () => invalid.judgeSession(judgeInput()),
    (error) => error.code === "invalid-judgement",
  )
})

test("拒绝召回当轮、区间外或没有用户原文的证据", async () => {
  for (const evidence of [[1], [99], [3]]) {
    const { engine } = makeEngine(() => feedbackOutput("confirmed", evidence))
    await assert.rejects(
      () =>
        engine.judgeSession(
          judgeInput({
            relevantTurns: [
              { turnNo: 2, userText: "对。", assistantText: "好。" },
              { turnNo: 3, userText: "", assistantText: "确认。" },
            ],
          }),
        ),
      (error) => error instanceof ValueEngineError && error.code === "invalid-judgement",
    )
  }
})

test("拒绝错误归属或丢失正文的召回快照", async () => {
  const { engine, calls } = makeEngine()
  const input = judgeInput()
  for (const patch of [
    { recalledContent: undefined },
    { recallSnapshots: [] },
    { recallSnapshots: [{ ...input.recallSnapshots[0], unitId: "another" }] },
    { recallTurnNos: [1, 3] },
    { relevantTurns: [{ turnNo: 1, userText: "召回当轮", assistantText: "" }] },
  ]) {
    await assert.rejects(
      () => engine.judgeSession({ ...input, ...patch }),
      (error) => error.code === "invalid-input",
    )
  }
  assert.equal(calls.length, 0)
})

test("模型异常和非法输出不能降级为无信号", async () => {
  for (const output of [
    "not JSON",
    { importance: "unknown", reason: "x" },
    {
      finish: { kind: "error", failure: { code: "TRANSPORT", message: "offline" } },
      content: [],
    },
  ]) {
    const { engine } = makeEngine(() => output)
    await assert.rejects(
      () => engine.judgeSession(judgeInput()),
      (error) => error.code === "model-failed",
    )
  }
  const { engine } = makeEngine(() => {
    throw new Error("offline")
  })
  await assert.rejects(
    () => engine.initialize([{ unitType: "detail", domain: "self", title: "t", body: "b" }]),
    (error) => error.code === "model-failed",
  )
})

test("取消信号透传给模型，已取消调用不产生反馈", async () => {
  const controller = new AbortController()
  const { engine, calls } = makeEngine(() => feedbackOutput())
  await engine.judgeSession(judgeInput({ signal: controller.signal }))
  assert.equal(calls[0].signal, controller.signal)
  const reason = new Error("cancelled")
  controller.abort(reason)
  await assert.rejects(
    () => engine.judgeSession(judgeInput({ signal: controller.signal })),
    (error) => error === reason,
  )
  assert.equal(calls.length, 1)
})

test("settle 按顺序处理反馈，不调用衰减，不修改原状态", async () => {
  const { engine } = makeEngine(() => feedbackOutput("supplemented"))
  const supplemented = await engine.judgeSession(judgeInput())
  const followUp = await makeEngine(() => feedbackOutput("follow_up")).engine.judgeSession(
    judgeInput(),
  )
  const state = engine.decay(initial())
  const before = JSON.stringify(state)
  const actual = engine.settle({ state, judgements: [supplemented, followUp] })
  const numeric = new ForgettingEngine()
  const expected = numeric.reinforce(
    numeric.reinforce(decodeValueState(state), "supplemented"),
    "follow_up",
  )
  assert.deepEqual(decodeValueState(actual), expected)
  assert.equal(decodeValueState(actual).activityCycles, 0)
  assert.equal(JSON.stringify(state), before)
  assert.deepEqual(engine.settle({ state, judgements: [] }), state)
})

test("settle 拒绝不认识的反馈版本和伪造的证据/态度", async () => {
  const { engine } = makeEngine(() => feedbackOutput())
  const judgement = await engine.judgeSession(judgeInput())
  for (const [patch, code] of [
    [{ judgementVersion: 99 }, "unsupported-judgement-version"],
    [{ evidenceTurnNos: [100] }, "invalid-judgement"],
    [{ feedbackType: "follow_up" }, "invalid-judgement"],
    [{ judgementData: { score: 1 } }, "invalid-judgement"],
  ]) {
    assert.throws(
      () => engine.settle({ state: initial(), judgements: [{ ...judgement, ...patch }] }),
      (error) => error.code === code,
    )
  }
})

test("仅标题/摘要和边界空白变化不调用模型，不强化", async () => {
  const { engine, calls } = makeEngine()
  const state = engine.decay(initial())
  const { oldContent } = contents()
  const result = await engine.reinforceUpdated({
    state,
    oldContent,
    newContent: {
      ...oldContent,
      title: "新标题",
      summary: "新摘要",
      body: `\n${oldContent.body}\r\n`,
    },
  })
  assert.deepEqual(result, state)
  assert.equal(calls.length, 0)
})

test("正文语义分类：纯改写和纠错不强化，补充和状态更新按旧 supplemented 增益计算", async () => {
  for (const changeType of [
    "unchanged",
    "rephrased",
    "corrected",
    "supplemented",
    "state_updated",
  ]) {
    const { engine, calls } = makeEngine(() => ({ changeType, reason: "正文变化分类。" }))
    const state = engine.decay(initial())
    const result = await engine.reinforceUpdated({ state, ...contents("detail") })
    const expected = ["supplemented", "state_updated"].includes(changeType)
      ? encodeValueState(new ForgettingEngine().reinforce(decodeValueState(state), "supplemented"))
      : state
    assert.deepEqual(result, expected)
    assert.equal(
      decodeValueState(result).intrinsicImportance,
      decodeValueState(state).intrinsicImportance,
    )
    assert.equal(calls[0].responseFormat.name, "memory_value_content_change")
  }
})

test("正文单元类型不一致时拒绝；归档单元不会被模型更新复活", async () => {
  const { engine, calls } = makeEngine(() => ({ changeType: "supplemented", reason: "补充。" }))
  await assert.rejects(
    () =>
      engine.reinforceUpdated({
        state: initial(),
        oldContent: contents().oldContent,
        newContent: contents("detail").newContent,
      }),
    (error) => error.code === "invalid-input",
  )
  let state = initial("low")
  for (let i = 0; i < 11; i++) {
    state = engine.decay(state)
  }
  assert.equal(engine.lifecycle(state), "archived")
  assert.deepEqual(await engine.reinforceUpdated({ state, ...contents() }), state)
  assert.equal(calls.length, 0)
})

test("max 按 V/S/P/较小周期/较小低值计数取完整状态，同值保留第一个", () => {
  const { engine } = makeEngine()
  const base = {
    ...decodeValueState(initial()),
    activityCycles: 4,
    currentValue: 0.3,
    belowThresholdCycles: 2,
  }
  const left = encodeValueState(base)
  for (const patch of [
    { currentValue: 0.4 },
    { consolidationStrength: 0.5 },
    { peakValue: 0.9 },
    { activityCycles: 3 },
    { belowThresholdCycles: 1 },
  ]) {
    const right = encodeValueState({ ...base, ...patch })
    assert.equal(engine.max(left, right), right)
    assert.equal(engine.max(right, left), right)
  }
  const same = encodeValueState(base)
  assert.equal(engine.max(left, same), left)
  assert.throws(
    () => engine.max(left, { valueVersion: "none", valueData: {} }),
    (error) => error.code === "unsupported-value-version",
  )
})
