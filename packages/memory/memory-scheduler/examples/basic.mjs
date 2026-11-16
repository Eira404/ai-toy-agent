// toy-memory-scheduler 基本用法演示（内存 mock，不连真库）。
import { Context } from "cordis"
import { ToyStorage } from "toy-storage"
import { MemoryScheduler, schedulerRelationalSchema } from "../lib/index.js"
import { FakeMemoryDaily, FakeMemoryFast, FakeRelational } from "../test/helpers.mjs"

const ctx = new Context()
const fibers = []
fibers.push(await ctx.plugin(ToyStorage))
fibers.push(await ctx.plugin(FakeRelational, { schema: schedulerRelationalSchema }))
fibers.push(await ctx.plugin(FakeMemoryFast, { pending: 4 }))
fibers.push(await ctx.plugin(FakeMemoryDaily))
fibers.push(await ctx.plugin(MemoryScheduler, { scheduleTickMs: 60_000, maxConcurrentRuns: 1 }))

try {
  const scope = { userId: "u1", memorySpaceId: "m1" }

  // 1) 配置每天 22:00、至少攒 3 条 Fast 才触发
  const schedule = await ctx.memoryScheduler.setDailySchedule({ ...scope, dailyAt: "22:00", minPendingFast: 3 })
  console.log("已配置调度：", schedule)

  // 2) 读回
  console.log("读回调度：", await ctx.memoryScheduler.getDailySchedule(scope))

  // 3) 手动触发一轮扫描（正常由后台定时器每分钟执行）
  console.log("扫描结果：", await ctx.memoryScheduler.runDue())

  // 4) 关闭调度
  await ctx.memoryScheduler.disableSchedule(scope)
  console.log("关闭后：", await ctx.memoryScheduler.getDailySchedule(scope))
} finally {
  for (const fiber of fibers.reverse()) {
    await fiber.dispose()
  }
}
