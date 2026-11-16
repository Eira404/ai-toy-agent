/* global AbortController */
import assert from "node:assert/strict"
import test from "node:test"
import { setImmediate } from "node:timers/promises"
import { LifecycleGraph, LifecycleProcessorError } from "toy-lifecycle"

function deferred() {
  let resolve
  const promise = new Promise((done) => {
    resolve = done
  })
  return { promise, resolve }
}

test("只等待直接依赖，无关的慢节点不阻塞分支，输出顺序独立于执行顺序", async () => {
  const graph = new LifecycleGraph()
  const slow = deferred()
  const unrelated = deferred()
  const started = []
  let upstream

  graph.register({
    name: "join",
    dependsOn: ["fast", "slow"],
    order: -1,
    process(context) {
      started.push("join")
      upstream = context.upstream
      return upstream.fast + upstream.slow
    },
  })
  graph.register({
    name: "fast",
    dependsOn: ["seed"],
    process: ({ upstream }) => upstream.seed + 1,
  })
  graph.register({
    name: "slow",
    async process() {
      started.push("slow")
      await slow.promise
      return 4
    },
  })
  graph.register({
    name: "unrelated",
    async process() {
      started.push("unrelated")
      await unrelated.promise
    },
  })
  graph.register({ name: "seed", process: ({ value }) => value })

  const run = graph.run({ value: 2 })
  try {
    await setImmediate()
    assert.deepEqual(started, ["slow", "unrelated"])
    slow.resolve()
    await setImmediate()
    assert.deepEqual(started, ["slow", "unrelated", "join"])
    assert.deepEqual(upstream, { fast: 3, slow: 4 })
  } finally {
    slow.resolve()
    unrelated.resolve()
  }

  const result = await run
  assert.equal(result.data.join, 7)
  assert.deepEqual(
    result.items.map(({ name }) => name),
    ["join", "fast", "slow", "unrelated", "seed"],
  )
  assert.ok(result.items.every(({ durationMs }) => durationMs >= 0))
})

test("注册校验名称和依赖，缺失依赖或成环时整张图不执行", async () => {
  const graph = new LifecycleGraph()
  const process = () => assert.fail("配置错误时不应调用处理器")
  assert.throws(() => graph.register({ name: " ", process }), /名称不能为空/)
  assert.throws(() => graph.register({ name: "self", dependsOn: [" self "], process }), /依赖自身/)
  assert.throws(
    () => graph.register({ name: "duplicate", dependsOn: ["a", " a "], process }),
    /重复节点/,
  )
  graph.register({ name: "root", process })
  graph.register({ name: "a", dependsOn: ["b"], process })
  assert.throws(() => graph.register({ name: " a ", process }), /已注册/)
  await assert.rejects(graph.run({}), /缺少依赖节点 'b'/)
  graph.register({ name: "b", dependsOn: ["a"], process })
  await assert.rejects(graph.run({}), /依赖环/)
})

test("运行使用注册快照，并发运行分别计算各自的结果", async () => {
  const graph = new LifecycleGraph()
  const gate = deferred()
  const unregister = graph.register({
    name: "profile",
    async process({ userId }) {
      await gate.promise
      return userId
    },
  })
  const first = graph.run({ userId: "first" })
  unregister()
  graph.register({ name: "profile", process: ({ userId }) => userId.toUpperCase() })
  unregister()

  try {
    assert.deepEqual((await graph.run({ userId: "second" })).data, { profile: "SECOND" })
  } finally {
    gate.resolve()
  }
  assert.deepEqual((await first).data, { profile: "first" })
})

test("保留失败节点和原始错误，跳过下游并等待独立分支", async () => {
  const graph = new LifecycleGraph()
  const gate = deferred()
  const cause = new Error("test failure")
  let reported = false
  let independentFinished = false
  let downstreamRan = false
  graph.register({
    name: "failing",
    process() {
      throw cause
    },
  })
  graph.register({
    name: "skipped",
    dependsOn: ["failing"],
    process() {
      downstreamRan = true
    },
  })
  graph.register({
    name: "independent",
    async process() {
      await gate.promise
      independentFinished = true
    },
  })
  const failure = assert
    .rejects(
      graph.run({}),
      (error) =>
        error instanceof LifecycleProcessorError &&
        error.processorName === "failing" &&
        error.cause === cause,
    )
    .then(() => {
      reported = true
    })
  try {
    await setImmediate()
    assert.equal(reported, false)
  } finally {
    gate.resolve()
  }
  await failure
  assert.equal(independentFinished, true)
  assert.equal(downstreamRan, false)
})

test("取消信号传给执行中的处理器，后续节点跳过", async () => {
  const graph = new LifecycleGraph()
  const controller = new AbortController()
  const cause = new Error("test abort")
  const gate = deferred()
  const signals = []
  let pendingRan = false
  graph.register({
    name: "running",
    async process({ signal }) {
      signals.push(signal)
      await gate.promise
    },
  })
  graph.register({
    name: "pending",
    dependsOn: ["running"],
    process() {
      pendingRan = true
    },
  })
  const options = { signal: controller.signal }
  const run = graph.run({}, options)
  try {
    await setImmediate()
    assert.deepEqual(signals, [controller.signal])
    controller.abort(cause)
  } finally {
    gate.resolve()
  }
  await assert.rejects(run, (error) => error === cause)
  await assert.rejects(graph.run({}, options), (error) => error === cause)
  assert.equal(signals.length, 1)
  assert.equal(pendingRan, false)
})

test("共享 state 可读写，传递依赖的写入对后续节点可见，run 结束返回同一份状态", async () => {
  const graph = new LifecycleGraph()
  const states = []
  graph.register({
    name: "a",
    process({ state }) {
      state.a = 1
      states.push(state)
    },
  })
  graph.register({
    name: "b",
    dependsOn: ["a"],
    process({ state }) {
      state.b = state.a + 1
      states.push(state)
    },
  })
  graph.register({
    name: "c",
    dependsOn: ["b"],
    process({ state, upstream }) {
      states.push(state)
      // a 是 c 的传递依赖而非直接依赖，但其写入已经可见。
      assert.equal(state.a, 1)
      assert.equal(state.b, 2)
      assert.deepEqual(upstream, { b: undefined })
      state.c = 3
    },
  })

  const result = await graph.run({}, { state: { seed: 0 } })
  assert.equal(result.state.seed, 0)
  assert.equal(result.state.a, 1)
  assert.equal(result.state.b, 2)
  assert.equal(result.state.c, 3)
  assert.equal(states[0], states[1])
  assert.equal(states[1], states[2])
})
