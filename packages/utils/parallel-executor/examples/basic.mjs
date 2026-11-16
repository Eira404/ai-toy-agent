/* global console */
import assert from "node:assert/strict"
import { setTimeout as sleep } from "node:timers/promises"
import { Context } from "cordis"
import { ParallelExecutor } from "toy-parallel-executor"

// 本地模拟异步任务，不需要数据库、API Key 或外部模型。
const ctx = new Context()
const fiber = await ctx.plugin(ParallelExecutor)

try {
  // 可以先注册插件，后续再提供任务池。
  ctx.parallelExecutor.registerPool("work", {
    maxConcurrency: 2,
    maxQueueSize: 20,
    attemptTimeoutMs: 5_000,
  })
  assert.equal(ctx.parallelExecutor.hasPool("work"), true)

  // 1. run：完整回调占一个任务名额，signal 透传到内部异步操作。
  const single = await ctx.parallelExecutor.run(
    async ({ taskId, attempt, signal }) => {
      await sleep(10, undefined, { signal })
      return { taskId, attempt, answer: 42 }
    },
    { pool: "work", taskId: "single", name: "example.single" },
  )
  console.log("run 结果：", single)

  // 2. map：批次想推进 3 项，但池上限为 2，实际最多运行 2 项。
  // 后面的任务耗时更短，完成次序可以变化，返回位置仍对应输入。
  const completed = []
  const values = await ctx.parallelExecutor.map(
    [60, 10, 5],
    async (duration, { index, signal }) => {
      await sleep(duration, undefined, { signal })
      completed.push(index)
      return `item-${index}`
    },
    { pool: "work", concurrency: 3, batchId: "ordered", name: "example.map" },
  )
  assert.deepEqual(values, ["item-0", "item-1", "item-2"])
  console.log("map 实际完成位置：", completed)
  console.log("map 有序返回结果：", values)

  // 3. mapSettled：一项失败不阻止其余项目，结果仍与输入一一对应。
  const results = await ctx.parallelExecutor.mapSettled(
    ["正常 A", "失败 B", "正常 C"],
    async (text, { signal }) => {
      await sleep(10, undefined, { signal })
      if (text === "失败 B") {
        throw new Error("模拟该项处理失败")
      }
      return text
    },
    { pool: "work", concurrency: 2 },
  )
  assert.deepEqual(
    results.map((item) => item.status),
    ["fulfilled", "rejected", "fulfilled"],
  )
  console.table(
    results.map((item) => ({
      index: item.index,
      status: item.status,
      attempts: item.attempts,
      result: item.status === "fulfilled" ? item.value : item.error.message,
    })),
  )

  await ctx.parallelExecutor.waitForIdle()
  console.log("池统计：", ctx.parallelExecutor.stats("work").pools.work)
} finally {
  // 卸载会取消并等待残留任务；正常结束时所有任务已经收尾。
  await fiber.dispose()
}
