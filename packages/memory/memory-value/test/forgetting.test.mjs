import assert from "node:assert/strict"
import test from "node:test"
import {
  ForgettingEngine,
  ForgettingConfigSchema,
  DEFAULT_FORGETTING_CONFIG,
  encodeValueState,
  decodeValueState,
  ValueEngineError,
} from "../lib/index.js"

test("默认算法复现旧版四档初值、首次低值周期与归档周期", () => {
  const engine = new ForgettingEngine()
  for (const [level, importance, peak, firstBelow, archived] of [
    ["low", 0.2, 0.53, 5, 11],
    ["normal", 0.45, 0.63, 9, 15],
    ["high", 0.7, 0.73, 18, 24],
    ["core", 1, 0.85, 46, 52],
  ]) {
    let state = engine.initialize(level)
    assert.equal(state.intrinsicImportance, importance)
    assert.ok(Math.abs(state.peakValue - peak) < 1e-12)
    for (let cycle = 1; cycle <= archived; cycle++) {
      state = engine.decayOneCycle(state)
      assert.equal(
        engine.lifecycle(state),
        cycle < firstBelow ? "active" : cycle < archived ? "observing" : "archived",
      )
    }
    assert.deepEqual(engine.decayOneCycle(state), state)
    assert.deepEqual(engine.reinforce(state, "confirmed"), state)
  }
})

test("重复间隔确认提升巩固强度，后续绝对损失递减，所有值保持边界", () => {
  const engine = new ForgettingEngine()
  let state = engine.initialize("normal")
  const losses = []
  for (const gap of [3, 5, 8]) {
    for (let i = 0; i < gap; i++) {
      state = engine.decayOneCycle(state)
    }
    const previous = state
    state = engine.reinforce(state, "confirmed")
    assert.ok(state.consolidationStrength > previous.consolidationStrength)
    assert.equal(state.activityCycles, 0)
    losses.push(state.currentValue - engine.decayOneCycle(state).currentValue)
  }
  assert.ok(losses[1] < losses[0] && losses[2] < losses[1])
  for (let i = 0; i < 100; i++) {
    state = engine.reinforce(engine.decayOneCycle(state), "supplemented")
    for (const key of [
      "intrinsicImportance",
      "consolidationStrength",
      "peakValue",
      "currentValue",
    ]) {
      assert.ok(state[key] >= 0 && state[key] <= 1)
    }
  }
})

test("无信号、纠错、无关、不确定均不强化；有效反馈可恢复观察态", () => {
  const engine = new ForgettingEngine()
  let state = engine.initialize("low")
  for (let i = 0; i < 5; i++) {
    state = engine.decayOneCycle(state)
  }
  const before = JSON.stringify(state)
  assert.equal(engine.lifecycle(state), "observing")
  for (const type of ["no_user_signal", "corrected", "irrelevant", "uncertain"]) {
    assert.deepEqual(engine.reinforce(state, type), state)
  }
  const strengthened = engine.reinforce(state, "confirmed")
  assert.equal(engine.lifecycle(strengthened), "active")
  assert.equal(strengthened.belowThresholdCycles, 0)
  assert.equal(JSON.stringify(state), before)
})

test("状态编解码拒绝未知版本、越界数据与不一致计数", () => {
  const data = new ForgettingEngine().initialize("normal")
  assert.deepEqual(decodeValueState(encodeValueState(data)), data)
  for (const version of ["none", "forgetting-v2"]) {
    assert.throws(
      () => decodeValueState({ valueVersion: version, valueData: data }),
      (error) => error instanceof ValueEngineError && error.code === "unsupported-value-version",
    )
  }
  for (const patch of [
    { currentValue: 2 },
    { belowThresholdCycles: 1 },
    { currentValue: data.peakValue + 0.01 },
  ]) {
    assert.throws(
      () => encodeValueState({ ...data, ...patch }),
      (error) => error instanceof ValueEngineError && error.code === "invalid-state",
    )
  }
})

test("算法配置校验范围与参数关系，不包含活动调度配置", () => {
  for (const patch of [
    { minimumDecay: 0 },
    { minimumPeak: 0.9 },
    { minimumDecay: 0.9 },
    { observationCycles: 0 },
    { activityTurnsPerCycle: 10 },
  ]) {
    assert.equal(
      ForgettingConfigSchema.safeParse({ ...DEFAULT_FORGETTING_CONFIG, ...patch }).success,
      false,
    )
  }
})
