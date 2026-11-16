/* global AbortController */
import assert from "node:assert/strict"
import test from "node:test"
import { setImmediate } from "node:timers/promises"
import { Context } from "cordis"
import { ToySession } from "toy-session"
import { SessionData } from "toy-session-data"

function deferred() {
  let resolve
  const promise = new Promise((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function setup(t, executeTurn) {
  const ctx = new Context()
  await ctx.plugin(SessionData)
  await ctx.plugin(ToySession)
  if (executeTurn !== undefined) {
    ctx.session.registerTurnExecutor(executeTurn)
  }
  t.after(async () => {
    await ctx.session.waitForPostprocessing()
    await ctx.fiber.dispose()
  })
  return ctx
}

const owner = { userId: "u1", deviceId: "d1" }

test("Agent 插件注册和卸载执行器，未注册时拒绝 Turn 且不写数据", async (t) => {
  const ctx = await setup(t)
  const sessionId = await ctx.session.createSession(owner)
  const input = { message: { text: "你好" } }
  await assert.rejects(ctx.session.runTurn(sessionId, input), {
    code: "invalid-state",
    message: "Turn 执行器尚未注册",
  })
  assert.deepEqual(ctx.sessionData.agent.getHistory(sessionId).turns, [])

  const started = deferred()
  const gate = deferred()
  const executeTurn = async ({ message }) => {
    started.resolve()
    await gate.promise
    return message.text
  }
  const agent = await ctx.plugin({
    name: "test-agent",
    inject: ["session"],
    apply(agentCtx) {
      agentCtx.effect(() => agentCtx.session.registerTurnExecutor(executeTurn))
    },
  })
  assert.throws(() => ctx.session.registerTurnExecutor(executeTurn), {
    code: "invalid-state",
    message: "Turn 执行器已注册",
  })

  const running = ctx.session.runTurn(sessionId, input)
  try {
    await started.promise
    const queued = assert.rejects(ctx.session.runTurn(sessionId, input), {
      code: "invalid-state",
      message: "Turn 执行器尚未注册",
    })
    await agent.dispose()
    gate.resolve()
    assert.equal((await running).result, "你好")
    await queued
    assert.equal(ctx.sessionData.agent.getHistory(sessionId).turns.length, 1)
  } finally {
    gate.resolve()
  }

  const unregister = ctx.session.registerTurnExecutor(executeTurn)
  unregister()
  ctx.session.registerTurnExecutor(executeTurn)
  unregister()
  assert.equal((await ctx.session.runTurn(sessionId, input)).result, "你好")
})

test("预处理结束后才创建并返回 ID，同一玩偶的并发创建只运行一次预处理", async (t) => {
  const ctx = await setup(t)
  const gate = deferred()
  const started = deferred()
  let preCount = 0
  ctx.session.preprocessing.register({
    name: "prompt",
    dependsOn: ["profile"],
    process: ({ upstream }) => `language=${upstream.profile.language}`,
  })
  ctx.session.preprocessing.register({
    name: "profile",
    async process({ payload }) {
      preCount += 1
      started.resolve()
      await gate.promise
      return { language: payload.language }
    },
  })

  const opening = ctx.session.createSession({ ...owner, payload: { language: "zh" } })
  try {
    await started.promise
    assert.equal(
      await ctx.sessionData.read.getActiveSession(owner.userId, owner.deviceId),
      undefined,
    )
    await assert.rejects(ctx.session.createSession(owner), { code: "active-session-exists" })
  } finally {
    gate.resolve()
  }

  const sessionId = await opening
  const record = await ctx.sessionData.read.getSession(sessionId)
  assert.equal(record.status, "active")
  assert.deepEqual(record.payload, {
    kind: "toy-session",
    initial: { language: "zh" },
    preprocessing: { profile: { language: "zh" }, prompt: "language=zh" },
  })
  await assert.rejects(ctx.session.createSession(owner), { code: "active-session-exists" })
  assert.equal(preCount, 1)
})

test("预处理失败释放创建占用，注销失败节点后可再次创建", async (t) => {
  const ctx = await setup(t)
  const unregister = ctx.session.preprocessing.register({
    name: "broken",
    process() {
      throw new Error("preprocessing failed")
    },
  })
  await assert.rejects(ctx.session.createSession(owner), { processorName: "broken" })
  assert.equal(await ctx.sessionData.read.getActiveSession(owner.userId, owner.deviceId), undefined)
  unregister()
  assert.ok(await ctx.session.createSession(owner))
})

test("执行器收到已写入的用户消息、Turn 总数和可直接使用的 Chat 历史", async (t) => {
  const inputs = []
  const ctx = await setup(t, async (input) => {
    const { session, turn, message, turnCount, history, appendEvents, getPreviousTurns } = input
    const current = ctx.sessionData.agent.getTurnEvents(session.sessionId, turn.turnId)
    assert.deepEqual(
      current.map(({ eventType, payload }) => ({ eventType, payload })),
      [{ eventType: "user_message", payload: { text: message.text } }],
    )
    inputs.push({ input, turnCount, history, previous: getPreviousTurns(1) })
    await appendEvents([
      { eventType: "tool_result", payload: { text: "工具内容" } },
      { eventType: "assistant_message", payload: { text: `回复 ${message.text}` } },
    ])
    return { replied: true }
  })

  const sessionId = await ctx.session.createSession(owner)
  await assert.rejects(ctx.session.runTurn(sessionId, { message: { text: " " } }), {
    code: "invalid-input",
  })
  const first = await ctx.session.runTurn(sessionId, { message: { text: "第一轮" } })
  const second = await ctx.session.runTurn(sessionId, { message: { text: "第二轮" } })
  assert.deepEqual(second, { turnId: inputs[1].input.turn.turnId, result: { replied: true } })
  assert.deepEqual(
    inputs.map(({ turnCount }) => turnCount),
    [1, 2],
  )
  assert.deepEqual(inputs[0].history, [])
  assert.deepEqual(inputs[1].history, [
    { role: "user", content: "第一轮" },
    { role: "assistant", content: "回复 第一轮" },
  ])
  assert.equal(inputs[1].previous[0].turn.turnId, first.turnId)
  assert.deepEqual(
    inputs[1].previous[0].events.map(({ eventType }) => eventType),
    ["user_message", "tool_result", "assistant_message"],
  )
  await assert.rejects(inputs[1].input.appendEvents([]), { code: "invalid-state" })
})

test("Turn config 在入队时取快照，保留显式 false 和扩展字段", async (t) => {
  const gate = deferred()
  const started = deferred()
  const ctx = await setup(t, async ({ config, message }) => {
    if (message.text === "first") {
      started.resolve()
      await gate.promise
    }
    return config
  })
  const sessionId = await ctx.session.createSession(owner)
  const first = ctx.session.runTurn(sessionId, { message: { text: "first" } })
  await started.promise
  const config = { thinking: false, options: { detail: "short" } }
  const second = ctx.session.runTurn(sessionId, { message: { text: "second" }, config })
  config.thinking = true
  config.options.detail = "long"
  gate.resolve()

  assert.equal((await first).result, undefined)
  assert.deepEqual((await second).result, { thinking: false, options: { detail: "short" } })
  assert.deepEqual(ctx.sessionData.agent.getHistory(sessionId).turns[1].events[0].payload, {
    text: "second",
  })
})

test("同一 Session 的 Turn 串行执行，执行失败后队列仍可继续", async (t) => {
  const gate = deferred()
  const started = []
  const ctx = await setup(t, async ({ message }) => {
    started.push(message.text)
    if (message.text === "first") {
      await gate.promise
      throw new Error("agent failure")
    }
  })
  const sessionId = await ctx.session.createSession(owner)
  const failed = assert.rejects(
    ctx.session.runTurn(sessionId, { message: { text: "first" } }),
    /agent failure/,
  )
  const next = ctx.session.runTurn(sessionId, { message: { text: "second" } })
  try {
    await setImmediate()
    assert.deepEqual(started, ["first"])
  } finally {
    gate.resolve()
  }
  await failed
  await next
  assert.deepEqual(started, ["first", "second"])
})

test("开始前和排队期间取消均不创建 Turn，排队取消立即返回", async (t) => {
  const gate = deferred()
  const started = []
  const ctx = await setup(t, async ({ message }) => {
    started.push(message.text)
    if (message.text === "running") {
      await gate.promise
    }
  })
  const sessionId = await ctx.session.createSession(owner)
  const reason = new Error("取消 Turn")
  const alreadyAborted = new AbortController()
  alreadyAborted.abort(reason)
  await assert.rejects(
    ctx.session.runTurn(sessionId, {
      message: { text: "before start" },
      signal: alreadyAborted.signal,
    }),
    (error) => error === reason,
  )
  assert.deepEqual(ctx.sessionData.agent.getHistory(sessionId).turns, [])

  const running = ctx.session.runTurn(sessionId, { message: { text: "running" } })
  const queued = new AbortController()
  let rejected = false
  const cancelled = assert
    .rejects(
      ctx.session.runTurn(sessionId, { message: { text: "queued" }, signal: queued.signal }),
      (error) => error === reason,
    )
    .then(() => {
      rejected = true
    })
  try {
    queued.abort(reason)
    await setImmediate()
    assert.equal(rejected, true)
    assert.deepEqual(started, ["running"])
    assert.equal(ctx.sessionData.agent.getHistory(sessionId).turns.length, 1)
  } finally {
    gate.resolve()
  }

  await Promise.all([running, cancelled])
  await ctx.session.runTurn(sessionId, { message: { text: "next" } })
  assert.deepEqual(started, ["running", "next"])
  assert.deepEqual(
    ctx.sessionData.agent.getHistory(sessionId).turns.map(({ turn }) => turn.turnNo),
    [1, 2],
  )
})

test("创建 Turn 时取消会先写完用户消息，再跳过 Agent", async (t) => {
  let called = false
  const ctx = await setup(t, () => {
    called = true
  })
  const sessionId = await ctx.session.createSession(owner)
  const controller = new AbortController()
  const reason = new Error("创建时取消")
  const unlisten = ctx.on("session-data/change", (change) => {
    if (change.kind === "turn-created" && change.sessionId === sessionId) {
      controller.abort(reason)
    }
  })
  try {
    await assert.rejects(
      ctx.session.runTurn(sessionId, { message: { text: "已接收" }, signal: controller.signal }),
      (error) => error === reason,
    )
    assert.equal(called, false)
    const { turns } = ctx.sessionData.agent.getHistory(sessionId)
    assert.equal(turns.length, 1)
    assert.deepEqual(
      turns[0].events.map(({ eventType, payload }) => ({ eventType, payload })),
      [{ eventType: "user_message", payload: { text: "已接收" } }],
    )
  } finally {
    unlisten()
  }
})

test("运行时把同一个信号传给 Agent，等它退出再放行下一轮", async (t) => {
  const controller = new AbortController()
  const reason = new Error("用户点击停止")
  const ready = deferred()
  const cleaningUp = deferred()
  const started = []
  let receivedSignal
  const ctx = await setup(t, async ({ message, signal, appendEvents }) => {
    started.push(message.text)
    if (message.text === "first") {
      receivedSignal = signal
      await appendEvents([{ eventType: "assistant_message", payload: { text: "已写入的回复" } }])
      ready.resolve()
      await cleaningUp.promise
    }
  })
  const sessionId = await ctx.session.createSession(owner)
  let rejected = false
  const cancelled = assert
    .rejects(
      ctx.session.runTurn(sessionId, { message: { text: "first" }, signal: controller.signal }),
      (error) => error === reason,
    )
    .then(() => {
      rejected = true
    })
  try {
    await ready.promise
    assert.equal(receivedSignal, controller.signal)
    const next = ctx.session.runTurn(sessionId, { message: { text: "second" } })
    controller.abort(reason)
    await setImmediate()
    assert.equal(receivedSignal.aborted, true)
    assert.equal(rejected, false)
    assert.deepEqual(started, ["first"])

    cleaningUp.resolve()
    await Promise.all([cancelled, next])
    assert.deepEqual(started, ["first", "second"])
    const { turns } = ctx.sessionData.agent.getHistory(sessionId)
    assert.equal(turns[0].events.at(-1).payload.text, "已写入的回复")
  } finally {
    cleaningUp.resolve()
  }
})

test("关闭等待当前轮，旧 Session 后处理期间同一玩偶可开启和使用新 Session", async (t) => {
  const turnStarted = deferred()
  const turnGate = deferred()
  const postStarted = deferred()
  const postGate = deferred()
  const ctx = await setup(t, async ({ message, appendEvents }) => {
    if (message.text === "old") {
      turnStarted.resolve()
      await turnGate.promise
    }
    await appendEvents([{ eventType: "assistant_message", payload: { text: message.text } }])
  })
  const oldId = await ctx.session.createSession({ ...owner, payload: { keep: true } })
  let postCount = 0
  ctx.session.postprocessing.register({
    name: "summary",
    async process({ session, turns }) {
      postCount += 1
      assert.equal(session.status, "closing")
      assert.equal(session.sessionId, oldId)
      assert.equal(turns.length, 1)
      assert.equal(turns[0].events.at(-1).eventType, "assistant_message")
      postStarted.resolve()
      await postGate.promise
      return { turnCount: turns.length }
    },
  })
  const turn = ctx.session.runTurn(oldId, { message: { text: "old" } })
  try {
    await turnStarted.promise
    const queued = ctx.session.runTurn(oldId, { message: { text: "queued" } })
    const close = ctx.session.requestClose(oldId)
    const repeated = ctx.session.requestClose(oldId)
    const queuedRejected = assert.rejects(queued, { code: "invalid-state" })
    await assert.rejects(ctx.session.runTurn(oldId, { message: { text: "late" } }), {
      code: "invalid-state",
    })
    assert.equal((await ctx.sessionData.read.getSession(oldId)).status, "active")
    turnGate.resolve()
    await Promise.all([turn, queuedRejected])
    assert.equal((await close).status, "closing")
    assert.deepEqual(await repeated, await close)
    await postStarted.promise
    assert.equal((await ctx.session.requestClose(oldId)).status, "closing")

    const newId = await ctx.session.createSession(owner)
    await ctx.session.runTurn(newId, { message: { text: "new" } })
    assert.equal((await ctx.sessionData.read.getSession(oldId)).status, "closing")

    postGate.resolve()
    await ctx.session.waitForPostprocessing()
    const closed = await ctx.sessionData.read.getSession(oldId)
    assert.equal(closed.status, "closed")
    assert.deepEqual(closed.payload.initial, { keep: true })
    assert.deepEqual(closed.payload.postprocessing, { summary: { turnCount: 1 } })
    assert.equal((await ctx.sessionData.read.getSession(newId)).status, "active")
    assert.equal(postCount, 1)
    assert.deepEqual(await ctx.session.requestClose(oldId), closed)
  } finally {
    turnGate.resolve()
    postGate.resolve()
  }
})

test("后处理失败保留 closing，重复申请可重试并保留旧 payload", async (t) => {
  const ctx = await setup(t)
  const { sessionId } = await ctx.sessionData.agent.createSession({
    ...owner,
    payload: "old payload",
    version: 3,
  })
  let attempts = 0
  ctx.session.postprocessing.register({
    name: "flaky",
    process() {
      attempts += 1
      if (attempts === 1) {
        throw new Error("temporary failure")
      }
    },
  })
  await ctx.session.requestClose(sessionId)
  await ctx.session.waitForPostprocessing()
  assert.equal((await ctx.sessionData.read.getSession(sessionId)).status, "closing")
  await ctx.session.requestClose(sessionId)
  await ctx.session.waitForPostprocessing()
  const closed = await ctx.sessionData.read.getSession(sessionId)
  assert.equal(closed.status, "closed")
  assert.deepEqual(closed.payload, {
    kind: "toy-session",
    initial: "old payload",
    initialVersion: 3,
    preprocessing: {},
    postprocessing: { flaky: null },
  })
  assert.equal(attempts, 2)
})
