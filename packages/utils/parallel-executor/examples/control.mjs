/* global console, AbortController */
import assert from "node:assert/strict"
import { setTimeout as sleep } from "node:timers/promises"
import { Context } from "cordis"
import { ParallelExecutor } from "toy-parallel-executor"
import { deferred } from "./support.mjs"

const ctx = new Context()
const fiber = await ctx.plugin(ParallelExecutor, {
  pools: { work: { maxConcurrency: 2 } },
})

try {
  // 1. 只为本次任务开启重试。每次重试都会重跑整个回调。
  const attempts = []
  const value = await ctx.parallelExecutor.run(
    async ({ attempt, signal }) => {
      attempts.push(attempt)
      await sleep(5, undefined, { signal })
      if (attempt === 1) {
        throw Object.assign(new Error("模拟临时故障"), { retryable: true })
      }
      return "重试成功"
    },
    {
      pool: "work",
      taskId: "retry-example",
      retry: {
        maxAttempts: 2,
        shouldRetry: (error) => error.retryable === true,
        baseDelayMs: 10,
        maxDelayMs: 20,
        jitter: false,
      },
    },
  )
  assert.deepEqual(attempts, [1, 2])
  console.log("重试：", value, "尝试序号：", attempts)

  // 2. 单次执行超时：内部 sleep 响应 signal，退出后再释放池名额。
  await assert.rejects(
    ctx.parallelExecutor.run(({ signal }) => sleep(1_000, undefined, { signal }), {
      pool: "work",
      attemptTimeoutMs: 20,
    }),
    (error) => {
      assert.equal(error.code, "ATTEMPT_TIMEOUT")
      assert.equal(error.attempts, 1)
      console.log("执行超时：", error.code)
      return true
    },
  )

  // 3. 外部取消 settled 批次：等待两项确实启动，再发出取消。
  const controller = new AbortController()
  const started = [deferred(), deferred()]
  const batch = ctx.parallelExecutor.mapSettled(
    ["A", "B", "C", "D"],
    async (item, { index, signal }) => {
      started[index].resolve()
      await sleep(1_000, undefined, { signal })
      return item
    },
    { pool: "work", concurrency: 2, signal: controller.signal },
  )
  await Promise.all(started.map((item) => item.promise))
  controller.abort("示例主动取消")
  const results = await batch
  assert.deepEqual(
    results.map((item) => item.status),
    Array(4).fill("cancelled"),
  )
  assert.deepEqual(
    results.map((item) => item.attempts),
    [1, 1, 0, 0],
  )
  console.table(results.map(({ index, status, attempts }) => ({ index, status, attempts })))
  console.log("前两项已启动后取消，后两项没有执行；没有把取消项当成成功。")

  await ctx.parallelExecutor.waitForIdle()
  console.log("最终统计：", ctx.parallelExecutor.stats("work").pools.work)
} finally {
  await fiber.dispose()
}
