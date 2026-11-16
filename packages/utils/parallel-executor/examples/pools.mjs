/* global console */
import assert from "node:assert/strict"
import { Context } from "cordis"
import { ParallelExecutor } from "toy-parallel-executor"
import { deferred } from "./support.mjs"

const ctx = new Context()
const fiber = await ctx.plugin(ParallelExecutor, {
  pools: {
    work: { maxConcurrency: 2, maxQueueSize: 10 },
    children: { maxConcurrency: 2 },
  },
})
const started = Array.from({ length: 4 }, () => deferred())
const releases = Array.from({ length: 4 }, () => deferred())
const tasks = []

try {
  // 四次独立调用共享同一个池，不会各自拥有两个执行名额。
  for (let index = 0; index < 4; index++) {
    tasks.push(
      ctx.parallelExecutor.run(
        async () => {
          console.log(`任务 ${index} 启动`)
          started[index].resolve()
          await releases[index].promise
          return index
        },
        { pool: "work", taskId: `task-${index}` },
      ),
    )
  }

  await Promise.all([started[0].promise, started[1].promise])
  assert.equal(ctx.parallelExecutor.stats("work").pools.work.running, 2)
  assert.equal(ctx.parallelExecutor.stats("work").pools.work.queued, 2)
  console.log("初始状态：", ctx.parallelExecutor.stats("work").pools.work)

  // 同名覆盖是完整替换。已有运行/排队任务保留，不创建第二个池。
  ctx.parallelExecutor.registerPool("work", { maxConcurrency: 1, maxQueueSize: 0 })
  releases[0].resolve()
  await tasks[0]
  assert.equal(ctx.parallelExecutor.stats("work").pools.work.running, 1)
  assert.equal(ctx.parallelExecutor.stats("work").pools.work.queued, 2)
  console.log("降为 1：剩余一个运行任务，原队列继续等待。")

  // 队列上限降低不驱逐旧任务，但新任务按新配置拒绝入队。
  await assert.rejects(
    ctx.parallelExecutor.run(() => "不会启动", { pool: "work" }),
    { code: "QUEUE_FULL" },
  )

  // 提高上限立即启动原队列的下一个任务，无需重新提交。
  ctx.parallelExecutor.registerPool("work", { maxConcurrency: 2 })
  await started[2].promise
  assert.equal(ctx.parallelExecutor.stats("work").pools.work.running, 2)
  assert.equal(ctx.parallelExecutor.stats("work").pools.work.maxQueueSize, 1000)
  console.log("升为 2：任务 2 已从原队列启动；未指定的队列上限恢复默认 1000。")

  for (const release of releases) {
    release.resolve()
  }
  assert.deepEqual(await Promise.all(tasks), [0, 1, 2, 3])

  // 不同池允许嵌套，父任务等待期间仍占 work 池的名额。
  const children = await ctx.parallelExecutor.run(
    () => ctx.parallelExecutor.map([1, 2], (value) => value * 10, { pool: "children" }),
    { pool: "work" },
  )
  console.log("跨池子任务结果：", children)

  // 同池嵌套会立即拒绝，避免父任务等自己的池名额。
  await assert.rejects(
    ctx.parallelExecutor.run(() => ctx.parallelExecutor.run(() => 1, { pool: "work" }), {
      pool: "work",
    }),
    { code: "POOL_REENTRY" },
  )
  console.log("同池嵌套：已按预期拒绝 POOL_REENTRY。")
} finally {
  // 即使断言失败，也释放本例人为阻塞的任务，保证插件能够退出。
  for (const release of releases) {
    release.resolve()
  }
  await Promise.allSettled(tasks)
  await fiber.dispose()
}
