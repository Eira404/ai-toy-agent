/* global AbortController */
import assert from "node:assert/strict"
import test from "node:test"
import { setImmediate as tick, setTimeout as delay } from "node:timers/promises"
import { Context, Service } from "cordis"
import { ParallelExecutor, ParallelError, ParallelBatchError } from "toy-parallel-executor"

function deferred() {
  let resolve
  const promise = new Promise((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function aborted(signal) {
  if (signal.aborted) {
    return Promise.reject(signal.reason)
  }
  return new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true })
  })
}

async function setup(t, config = {}) {
  const ctx = new Context()
  const fiber = await ctx.plugin(ParallelExecutor, config)
  const holds = []
  t.after(async () => {
    for (const hold of holds) {
      hold.resolve()
    }
    await fiber.dispose()
  })
  return {
    ctx,
    fiber,
    executor: ctx.parallelExecutor,
    hold() {
      const hold = deferred()
      holds.push(hold)
      return hold
    },
  }
}

const code = (expected) => (error) => error instanceof ParallelError && error.code === expected

test("池配置和重试策略复制；单任务禁用重试不影响池策略", async (t) => {
  const { executor } = await setup(t)
  const retry = {
    maxAttempts: 2,
    shouldRetry: () => true,
    baseDelayMs: 1,
    maxDelayMs: 1,
    jitter: false,
  }
  const config = { maxConcurrency: 1, queueTimeoutMs: null, retry }
  executor.registerPool("jobs", config)
  config.maxConcurrency = 100
  retry.maxAttempts = 20
  assert.equal(executor.stats().pools.jobs.maxConcurrency, 1)
  let calls = 0
  await assert.rejects(
    executor.run(
      () => {
        calls++
        throw new Error("retry")
      },
      { pool: "jobs" },
    ),
    (error) => code("TASK_FAILED")(error) && error.attempts === 2,
  )
  assert.equal(calls, 2)
  calls = 0
  await assert.rejects(
    executor.run(
      () => {
        calls++
        throw new Error("no retry")
      },
      { pool: "jobs", retry: false },
    ),
    (error) => code("TASK_FAILED")(error) && error.attempts === 1,
  )
  assert.equal(calls, 1)
})

test("同池排队顺序在不同调用方之间保持 FIFO", async (t) => {
  const app = await setup(t, { pools: { jobs: { maxConcurrency: 1 } } })
  const gate = app.hold()
  const first = app.executor.run(() => gate.promise, { pool: "jobs" })
  const order = []
  const tasks = [1, 2, 3].map((value) =>
    app.executor.run(
      () => {
        order.push(value)
      },
      { pool: "jobs" },
    ),
  )
  gate.resolve()
  await Promise.all([first, ...tasks])
  assert.deepEqual(order, [1, 2, 3])
})

test("尚未提交的批次项目使用新池默认值，已提交项保留原策略", async (t) => {
  const app = await setup(t, { pools: { jobs: { maxConcurrency: 1, attemptTimeoutMs: 10 } } })
  const firstStarted = deferred()
  const batch = app.executor.mapSettled(
    [0, 1],
    async (item, { signal }) => {
      if (item === 0) {
        firstStarted.resolve()
        await aborted(signal)
      }
      await delay(20)
      return item
    },
    { pool: "jobs", concurrency: 1 },
  )
  await firstStarted.promise
  app.executor.registerPool("jobs", { maxConcurrency: 1 })
  const results = await batch
  assert.equal(results[0].status, "rejected")
  assert.equal(results[0].error.code, "ATTEMPT_TIMEOUT")
  assert.equal(results[1].status, "fulfilled")
})

test("任务总预算包含排队，且任务没有启动时 attempts=0", async (t) => {
  const app = await setup(t, { pools: { jobs: { maxConcurrency: 1 } } })
  const gate = app.hold()
  const first = app.executor.run(() => gate.promise, { pool: "jobs" })
  await assert.rejects(
    app.executor.run(() => assert.fail("不应启动"), {
      pool: "jobs",
      totalTimeoutMs: 10,
      queueTimeoutMs: null,
    }),
    (error) => code("TOTAL_TIMEOUT")(error) && error.attempts === 0,
  )
  gate.resolve()
  await first
})

test("任务重试重新排队后不继承覆盖的新池重试策略", async (t) => {
  const app = await setup(t, {
    pools: {
      jobs: {
        maxConcurrency: 1,
        retry: {
          maxAttempts: 2,
          shouldRetry: () => true,
          baseDelayMs: 30,
          maxDelayMs: 30,
          jitter: false,
        },
      },
    },
  })
  const firstAttempt = deferred()
  let calls = 0
  const task = app.executor.run(
    ({ attempt }) => {
      calls++
      if (attempt === 1) {
        firstAttempt.resolve()
        throw new Error("temporary")
      }
      return 8
    },
    { pool: "jobs" },
  )
  await firstAttempt.promise
  app.executor.registerPool("jobs", { maxConcurrency: 1, retry: false })
  assert.equal(await task, 8)
  assert.equal(calls, 2)
})

test("池覆盖不绕过正在执行父任务的嵌套检查", async (t) => {
  const { executor } = await setup(t, { pools: { jobs: { maxConcurrency: 1 } } })
  await assert.rejects(
    executor.run(
      () => {
        executor.registerPool("jobs", { maxConcurrency: 10 })
        return executor.run(() => 1, { pool: "jobs" })
      },
      { pool: "jobs" },
    ),
    code("POOL_REENTRY"),
  )
})

test("取消重试等待立即收尾，不开始下一次尝试", async (t) => {
  const { executor } = await setup(t, { pools: { jobs: { maxConcurrency: 1 } } })
  const controller = new AbortController()
  const attempted = deferred()
  let calls = 0
  const task = executor.run(
    () => {
      calls++
      attempted.resolve()
      throw new Error("temporary")
    },
    {
      pool: "jobs",
      signal: controller.signal,
      retry: { maxAttempts: 2, shouldRetry: () => true, baseDelayMs: 100, jitter: false },
    },
  )
  const rejected = assert.rejects(task, code("CANCELLED"))
  await attempted.promise
  await tick()
  controller.abort()
  await rejected
  assert.equal(calls, 1)
  assert.equal(executor.stats().pools.jobs.retryWaiting, 0)
})

test("Cordis 服务可注入，保留内置 parallel 事件方法，卸载后可重新挂载", async (t) => {
  const app = await setup(t)
  assert.equal(typeof app.ctx.parallel, "function")
  class Consumer extends Service {
    static inject = ["parallelExecutor"]
    constructor(ctx) {
      super(ctx, "consumer")
    }

    execute() {
      return this.ctx.parallelExecutor.run(() => 42, { pool: "work" })
    }
  }
  app.executor.registerPool("work", { maxConcurrency: 1 })
  const consumer = await app.ctx.plugin(Consumer)
  assert.equal(await app.ctx.consumer.execute(), 42)
  await consumer.dispose()
  await app.fiber.dispose()
  const next = await app.ctx.plugin(ParallelExecutor)
  try {
    assert.equal(app.ctx.parallelExecutor.hasPool("work"), false)
  } finally {
    await next.dispose()
  }
})

test("支持零初始池、未知池错误、覆盖及失败时保留原配置", async (t) => {
  const { executor } = await setup(t)
  assert.equal(executor.hasPool("jobs"), false)
  await assert.rejects(
    executor.run(() => 1, { pool: "jobs" }),
    code("UNKNOWN_POOL"),
  )
  executor.registerPool("jobs", { maxConcurrency: 3, maxQueueSize: 7, attemptTimeoutMs: 1 })
  assert.throws(() => executor.registerPool("jobs", { maxConcurrency: 0 }), code("INVALID_OPTIONS"))
  assert.equal(executor.stats("jobs").pools.jobs.maxConcurrency, 3)
  executor.registerPool("jobs", { maxConcurrency: 1 })
  assert.equal(executor.stats("jobs").pools.jobs.maxQueueSize, 1000)
  // 旧 1ms 超时不继承。
  assert.equal(
    await executor.run(
      async () => {
        await delay(10)
        return 2
      },
      { pool: "jobs" },
    ),
    2,
  )
})

test("校验池与调用参数；无效批次不会执行任何任务", async (t) => {
  const { executor } = await setup(t, { pools: { jobs: { maxConcurrency: 2 } } })
  for (const config of [
    { maxConcurrency: 1.5 },
    { maxConcurrency: 1, maxQueueSize: -1 },
    { maxConcurrency: 1, queueTimeoutMs: 0 },
    { maxConcurrency: 1, attemptTimeoutMs: 2 ** 31 },
    { maxConcurrency: 1, retry: { maxAttempts: 2 } },
  ]) {
    assert.throws(() => executor.registerPool("jobs", config), code("INVALID_OPTIONS"))
  }
  let calls = 0
  await assert.rejects(
    executor.map([1], () => calls++, { pool: "jobs", concurrency: 0 }),
    code("INVALID_OPTIONS"),
  )
  await assert.rejects(
    executor.mapSettled([], () => 1, { pool: "missing" }),
    code("UNKNOWN_POOL"),
  )
  assert.equal(calls, 0)
  assert.deepEqual(await executor.map([], () => calls++, { pool: "jobs" }), [])
  assert.deepEqual(await executor.mapSettled([], () => calls++, { pool: "jobs" }), [])
})

test("两个批次共享池硬上限，结果按输入位置返回", async (t) => {
  const app = await setup(t, { pools: { jobs: { maxConcurrency: 2 } } })
  const gates = Array.from({ length: 6 }, () => app.hold())
  const started = []
  let running = 0
  let maximum = 0
  const worker = async (value, context) => {
    assert.equal(context.pool, "jobs")
    assert.ok(context.taskId.startsWith(context.batchId))
    running++
    maximum = Math.max(maximum, running)
    started.push(value)
    await gates[value].promise
    running--
    return value * 2
  }
  const a = app.executor.map([0, 1, 2], worker, { pool: "jobs", concurrency: 3 })
  const b = app.executor.map([3, 4, 5], worker, { pool: "jobs", concurrency: 3 })
  await tick()
  assert.equal(started.length, 2)
  gates[1].resolve()
  await tick()
  assert.equal(started.length, 3)
  for (const gate of gates) {
    gate.resolve()
  }
  assert.deepEqual(await a, [0, 2, 4])
  assert.deepEqual(await b, [6, 8, 10])
  assert.equal(maximum, 2)
  assert.equal(app.executor.stats().pools.jobs.attemptsStarted, 6)
})

test("单批并发限制项目数，不一次提交整个大数组", async (t) => {
  const app = await setup(t, { pools: { jobs: { maxConcurrency: 8 } } })
  const gate = app.hold()
  const batch = app.executor.map(
    Array.from({ length: 20 }, (_, index) => index),
    async (value) => {
      await gate.promise
      return value
    },
    { pool: "jobs", concurrency: 2 },
  )
  await tick()
  assert.equal(app.executor.stats().pools.jobs.submitted, 2)
  assert.equal(app.executor.stats().pools.jobs.running, 2)
  gate.resolve()
  assert.equal((await batch).length, 20)
})

test("降低并发保留运行任务；提高并发立即派发原队列，FIFO 不变", async (t) => {
  const app = await setup(t, { pools: { jobs: { maxConcurrency: 3 } } })
  const gates = Array.from({ length: 5 }, () => app.hold())
  const started = []
  const jobs = gates.map((gate, index) =>
    app.executor.run(
      async () => {
        started.push(index)
        await gate.promise
      },
      { pool: "jobs" },
    ),
  )
  await tick()
  assert.deepEqual(started, [0, 1, 2])
  app.executor.registerPool("jobs", { maxConcurrency: 1, maxQueueSize: 0 })
  assert.equal(app.executor.stats().pools.jobs.queued, 2)
  gates[0].resolve()
  gates[1].resolve()
  await tick()
  assert.deepEqual(started, [0, 1, 2])
  app.executor.registerPool("jobs", { maxConcurrency: 2 })
  await tick()
  assert.deepEqual(started, [0, 1, 2, 3])
  gates[3].resolve()
  await tick()
  assert.deepEqual(started, [0, 1, 2, 3, 4])
  for (const gate of gates) {
    gate.resolve()
  }
  await Promise.all(jobs)
})

test("已提交任务保留策略，新任务读取覆盖后的默认值", async (t) => {
  const app = await setup(t, { pools: { jobs: { maxConcurrency: 1, attemptTimeoutMs: 10 } } })
  const gate = app.hold()
  const first = app.executor.run(() => gate.promise, { pool: "jobs", attemptTimeoutMs: null })
  const old = app.executor.run(({ signal }) => aborted(signal), { pool: "jobs" })
  const rejected = assert.rejects(old, code("ATTEMPT_TIMEOUT"))
  app.executor.registerPool("jobs", { maxConcurrency: 1 })
  const next = app.executor.run(
    async () => {
      await delay(20)
      return "new"
    },
    { pool: "jobs" },
  )
  gate.resolve()
  await first
  await rejected
  assert.equal(await next, "new")
})

test("队列满拒绝新任务；取消队列任务后可以再次提交", async (t) => {
  const app = await setup(t, { pools: { jobs: { maxConcurrency: 1, maxQueueSize: 1 } } })
  const gate = app.hold()
  const first = app.executor.run(() => gate.promise, { pool: "jobs" })
  const controller = new AbortController()
  const queued = app.executor.run(() => assert.fail("取消项不应启动"), {
    pool: "jobs",
    signal: controller.signal,
  })
  const cancelled = assert.rejects(
    queued,
    (error) => code("CANCELLED")(error) && error.attempts === 0,
  )
  await assert.rejects(
    app.executor.run(() => 3, { pool: "jobs" }),
    code("QUEUE_FULL"),
  )
  controller.abort("stop")
  await cancelled
  const third = app.executor.run(() => 3, { pool: "jobs" })
  gate.resolve()
  await first
  assert.equal(await third, 3)
})

test("maxQueueSize=0 允许立即运行，满载时不允许排队", async (t) => {
  const app = await setup(t, { pools: { jobs: { maxConcurrency: 1, maxQueueSize: 0 } } })
  const gate = app.hold()
  const first = app.executor.run(() => gate.promise, { pool: "jobs" })
  await assert.rejects(
    app.executor.run(() => 1, { pool: "jobs" }),
    code("QUEUE_FULL"),
  )
  gate.resolve()
  await first
})

test("排队超时不执行、不重试；null 覆盖池的排队期限", async (t) => {
  const app = await setup(t, { pools: { jobs: { maxConcurrency: 1, queueTimeoutMs: 10 } } })
  const gate = app.hold()
  const first = app.executor.run(() => gate.promise, { pool: "jobs" })
  let retries = 0
  await assert.rejects(
    app.executor.run(() => assert.fail("不应执行"), {
      pool: "jobs",
      retry: {
        maxAttempts: 2,
        shouldRetry() {
          retries++
          return true
        },
      },
    }),
    (error) => code("QUEUE_TIMEOUT")(error) && error.attempts === 0,
  )
  const unlimited = app.executor.run(() => 9, { pool: "jobs", queueTimeoutMs: null })
  await delay(20)
  assert.equal(app.executor.stats().pools.jobs.queued, 1)
  gate.resolve()
  await first
  assert.equal(await unlimited, 9)
  assert.equal(retries, 0)
})

test("尝试超时等待忽略信号的任务退出，期间不释放名额或重叠重试", async (t) => {
  const app = await setup(t, { pools: { jobs: { maxConcurrency: 1 } } })
  const gate = app.hold()
  const timedOut = deferred()
  let calls = 0
  const first = app.executor.run(
    async ({ signal }) => {
      calls++
      if (calls === 1) {
        signal.addEventListener("abort", () => timedOut.resolve(), { once: true })
        await gate.promise
      }
      return "retried"
    },
    {
      pool: "jobs",
      attemptTimeoutMs: 10,
      retry: {
        maxAttempts: 2,
        shouldRetry: (error) => error.code === "ATTEMPT_TIMEOUT",
        baseDelayMs: 1,
        maxDelayMs: 1,
      },
    },
  )
  await timedOut.promise
  const order = []
  const second = app.executor.run(
    () => {
      order.push("second")
      return 2
    },
    { pool: "jobs" },
  )
  await tick()
  assert.equal(app.executor.stats().pools.jobs.running, 1)
  assert.equal(calls, 1)
  assert.deepEqual(order, [])
  gate.resolve()
  assert.equal(await first, "retried")
  assert.equal(await second, 2)
  assert.equal(calls, 2)
})

test("重试等待释放池名额；按输入有序返回并记录真实尝试次数", async (t) => {
  const app = await setup(t, { pools: { jobs: { maxConcurrency: 1 } } })
  const failedOnce = deferred()
  const first = app.executor.mapSettled(
    [1],
    (_item, task) => {
      if (task.attempt === 1) {
        failedOnce.resolve()
        throw new Error("temporary")
      }
      return task.attempt
    },
    {
      pool: "jobs",
      task: {
        retry: {
          maxAttempts: 2,
          shouldRetry: () => true,
          baseDelayMs: 30,
          maxDelayMs: 30,
          jitter: false,
        },
      },
    },
  )
  await failedOnce.promise
  await tick()
  assert.equal(app.executor.stats().pools.jobs.retryWaiting, 1)
  assert.equal(await app.executor.run(() => 7, { pool: "jobs" }), 7)
  const [result] = await first
  assert.equal(result.status, "fulfilled")
  assert.equal(result.attempts, 2)
  assert.equal(result.value, 2)
})

test("总超时覆盖退避等待，不会因允许重试而重新执行", async (t) => {
  const { executor } = await setup(t, { pools: { jobs: { maxConcurrency: 1 } } })
  let calls = 0
  await assert.rejects(
    executor.run(
      () => {
        calls++
        throw new Error("temporary")
      },
      {
        pool: "jobs",
        totalTimeoutMs: 15,
        retry: { maxAttempts: 3, shouldRetry: () => true, retryAfterMs: () => 100, baseDelayMs: 1 },
      },
    ),
    code("TOTAL_TIMEOUT"),
  )
  assert.equal(calls, 1)
  assert.equal(executor.stats().pools.jobs.retryWaiting, 0)
})

test("严格批次停止未提交项目，等待在途任务收尾后才拒绝", async (t) => {
  const app = await setup(t, { pools: { jobs: { maxConcurrency: 2 } } })
  const failGate = app.hold()
  const drain = app.hold()
  const started = []
  let cancelled = false
  let finished = false
  const original = new Error("invalid output")
  const batch = app.executor.map(
    [0, 1, 2, 3],
    async (value, { signal }) => {
      started.push(value)
      if (value === 0) {
        await failGate.promise
        throw original
      }
      signal.addEventListener(
        "abort",
        () => {
          cancelled = true
        },
        { once: true },
      )
      await drain.promise
      return value
    },
    { pool: "jobs", concurrency: 2, batchId: "strict" },
  )
  const rejection = assert.rejects(batch, (error) => {
    finished = true
    assert.ok(error instanceof ParallelBatchError)
    assert.equal(error.index, 0)
    assert.equal(error.cause.cause, original)
    return true
  })
  await tick()
  failGate.resolve()
  await tick()
  assert.equal(cancelled, true)
  assert.equal(finished, false)
  assert.deepEqual(started, [0, 1])
  drain.resolve()
  await rejection
})

test("严格批次失败先移除同批排队项，再把名额交给其他批次", async (t) => {
  const { executor } = await setup(t, { pools: { jobs: { maxConcurrency: 1 } } })
  const started = []
  const batch = executor.map(
    [0, 1, 2],
    (value) => {
      started.push(value)
      throw new Error("stop")
    },
    { pool: "jobs", concurrency: 3 },
  )
  await assert.rejects(batch, ParallelBatchError)
  assert.deepEqual(started, [0])
  assert.equal(await executor.run(() => 5, { pool: "jobs" }), 5)
})

test("mapSettled 收集同步和异步错误、undefined 成功及剩余成功项", async (t) => {
  const { executor } = await setup(t, { pools: { jobs: { maxConcurrency: 2 } } })
  const results = await executor.mapSettled(
    [0, 1, 2, 3],
    (value) => {
      if (value === 0) {
        throw new Error("sync")
      }
      if (value === 1) {
        return Promise.reject(new Error("async"))
      }
      return value === 2 ? undefined : 30
    },
    { pool: "jobs", concurrency: 2 },
  )
  assert.deepEqual(
    results.map((result) => result.status),
    ["rejected", "rejected", "fulfilled", "fulfilled"],
  )
  assert.deepEqual(
    results.map((result) => result.attempts),
    [1, 1, 1, 1],
  )
  assert.equal(results[2].value, undefined)
  assert.equal(results[3].value, 30)
})

test("取消 settled 批次：运行项取消，未提交项 attempts=0，数组完整", async (t) => {
  const { executor } = await setup(t, { pools: { jobs: { maxConcurrency: 1 } } })
  const controller = new AbortController()
  const batch = executor.mapSettled([1, 2, 3], (_value, { signal }) => aborted(signal), {
    pool: "jobs",
    concurrency: 1,
    signal: controller.signal,
  })
  await tick()
  controller.abort("stop")
  const results = await batch
  assert.deepEqual(
    results.map((result) => result.status),
    ["cancelled", "cancelled", "cancelled"],
  )
  assert.deepEqual(
    results.map((result) => result.attempts),
    [1, 0, 0],
  )
})

test("批次期限取消在途任务；预取消不会执行 worker", async (t) => {
  const { executor } = await setup(t, { pools: { jobs: { maxConcurrency: 1 } } })
  await assert.rejects(
    executor.map([1], (_value, { signal }) => aborted(signal), {
      pool: "jobs",
      batchTimeoutMs: 10,
    }),
    (error) => error instanceof ParallelBatchError && error.code === "TOTAL_TIMEOUT",
  )
  const controller = new AbortController()
  controller.abort("already")
  const results = await executor.mapSettled([1, 2], () => assert.fail("不应执行"), {
    pool: "jobs",
    signal: controller.signal,
  })
  assert.deepEqual(
    results.map((result) => result.attempts),
    [0, 0],
  )
})

test("跨池嵌套允许，同池及 A→B→A 嵌套立即拒绝，父取消自动传递", async (t) => {
  const { executor } = await setup(t, {
    pools: { a: { maxConcurrency: 1 }, b: { maxConcurrency: 1 } },
  })
  assert.equal(await executor.run(() => executor.run(() => 8, { pool: "b" }), { pool: "a" }), 8)
  await assert.rejects(
    executor.run(() => executor.map([1], () => 1, { pool: "a" }), { pool: "a" }),
    code("POOL_REENTRY"),
  )
  await assert.rejects(
    executor.run(
      () =>
        executor.run(() => executor.run(() => 1, { pool: "a" }), {
          pool: "b",
        }),
      { pool: "a" },
    ),
    code("POOL_REENTRY"),
  )
  const childStarted = deferred()
  const controller = new AbortController()
  const parent = executor.run(
    () =>
      executor.run(
        ({ signal }) => {
          childStarted.resolve()
          return aborted(signal)
        },
        { pool: "b" },
      ),
    { pool: "a", signal: controller.signal },
  )
  const rejected = assert.rejects(parent, code("CANCELLED"))
  await childStarted.promise
  controller.abort("stop parent")
  await rejected
})

test("waitForIdle 取消只结束等待，统计快照不能修改服务状态", async (t) => {
  const app = await setup(t, { pools: { jobs: { maxConcurrency: 1 } } })
  const gate = app.hold()
  const task = app.executor.run(() => gate.promise, { pool: "jobs" })
  const controller = new AbortController()
  const waiting = app.executor.waitForIdle({ signal: controller.signal })
  const rejected = assert.rejects(waiting, code("CANCELLED"))
  controller.abort()
  await rejected
  const snapshot = app.executor.stats()
  snapshot.pools.jobs.running = 500
  assert.equal(app.executor.stats().pools.jobs.running, 1)
  const idle = app.executor.waitForIdle()
  gate.resolve()
  await task
  await idle
  const stats = app.executor.stats()
  assert.equal(stats.pools.jobs.running, 0)
  assert.equal(stats.pools.jobs.succeeded, 1)
})

test("插件卸载取消运行和排队任务，并等待不响应取消的任务退出", async (t) => {
  const app = await setup(t, { pools: { jobs: { maxConcurrency: 1 } } })
  const gate = app.hold()
  const started = deferred()
  const first = app.executor.run(
    async () => {
      started.resolve()
      await gate.promise
    },
    { pool: "jobs" },
  )
  const queued = app.executor.run(() => assert.fail("关闭后不能启动"), { pool: "jobs" })
  const firstRejected = assert.rejects(first, code("SERVICE_CLOSED"))
  const queuedRejected = assert.rejects(queued, code("SERVICE_CLOSED"))
  await started.promise
  let disposed = false
  const disposing = app.fiber.dispose().then(() => {
    disposed = true
  })
  await tick()
  assert.equal(disposed, false)
  assert.equal(app.executor.stats().pools.jobs.running, 1)
  await assert.rejects(
    app.executor.run(() => 1, { pool: "jobs" }),
    code("SERVICE_CLOSED"),
  )
  gate.resolve()
  await Promise.all([firstRejected, queuedRejected, disposing])
  assert.equal(disposed, true)
  assert.equal(app.executor.stats().pools.jobs.running, 0)
})
