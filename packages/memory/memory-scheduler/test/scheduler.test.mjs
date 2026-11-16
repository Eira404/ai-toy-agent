import assert from "node:assert/strict"
import test from "node:test"
import { Context } from "cordis"
import { ToyStorage } from "toy-storage"
import {
  MemoryScheduler,
  SCHEDULES_TABLE,
  nextDailyOccurrence,
  parseDailyAt,
  schedulerRelationalSchema,
  serverTimeZone,
} from "../lib/index.js"
import { FakeMemoryDaily, FakeMemoryFast, FakeRelational } from "./helpers.mjs"

const NOW = "2026-11-12T14:00:00.000Z"
const PAST = "2000-01-01T00:00:00.000Z"

const SCOPE = { userId: "u1", memorySpaceId: "m1" }

async function setup({ now = NOW, pending = 0, ...config } = {}) {
  const ctx = new Context()
  const fibers = []
  fibers.push(await ctx.plugin(ToyStorage))
  fibers.push(await ctx.plugin(FakeRelational, { schema: schedulerRelationalSchema }))
  fibers.push(await ctx.plugin(FakeMemoryFast, { pending }))
  fibers.push(await ctx.plugin(FakeMemoryDaily))
  fibers.push(
    await ctx.plugin(MemoryScheduler, {
      now: () => now,
      scheduleTickMs: 60_000,
      maxConcurrentRuns: 1,
      ...config,
    }),
  )
  return {
    ctx,
    scheduler: ctx.memoryScheduler,
    database: ctx.storage.get("relational", "main"),
    daily: ctx.memoryDaily,
    fast: ctx.memoryFast,
    async dispose() {
      for (const fiber of fibers.reverse()) {
        await fiber.dispose()
      }
    },
  }
}

/** 把某空间的 next_run_at 强制改到过去，模拟「已到期」。 */
async function forceDue(database, memorySpaceId) {
  await database.execute({
    type: "update",
    table: SCHEDULES_TABLE,
    where: { type: "eq", field: "memory_space_id", value: memorySpaceId },
    patch: { next_run_at: PAST },
  })
}

test("parseDailyAt 校验 HH:mm", () => {
  assert.deepEqual(parseDailyAt("22:00"), { hours: 22, minutes: 0 })
  assert.deepEqual(parseDailyAt("08:05"), { hours: 8, minutes: 5 })
  assert.equal(parseDailyAt("8:00"), null) // 未补零
  assert.equal(parseDailyAt("24:00"), null)
  assert.equal(parseDailyAt("22:60"), null)
  assert.equal(parseDailyAt(""), null)
})

test("nextDailyOccurrence 按给定 IANA 时区换算下一个触发点", () => {
  const now = new Date("2026-11-12T12:00:00.000Z")
  // 22:00 Asia/Shanghai = 14:00 UTC（当天，晚于 now）
  assert.equal(nextDailyOccurrence(now, "22:00", "Asia/Shanghai"), "2026-11-12T14:00:00.000Z")
  // 22:00 UTC
  assert.equal(nextDailyOccurrence(now, "22:00", "UTC"), "2026-11-12T22:00:00.000Z")
  // 当天 08:00 UTC 已过 → 次日
  assert.equal(nextDailyOccurrence(now, "08:00", "UTC"), "2026-11-13T08:00:00.000Z")
  // 纽约（西五区，2026-11 为 EST）22:00 = 次日 03:00 UTC
  assert.equal(nextDailyOccurrence(now, "22:00", "America/New_York"), "2026-11-13T03:00:00.000Z")
})

test("setDailySchedule 落库并计算未来的 next_run_at，getDailySchedule 读回", async () => {
  const app = await setup()
  try {
    const schedule = await app.scheduler.setDailySchedule({ ...SCOPE, dailyAt: "22:00" })
    assert.equal(schedule.memorySpaceId, "m1")
    assert.equal(schedule.userId, "u1")
    assert.equal(schedule.enabled, true)
    assert.equal(schedule.minPendingFast, 1)
    // 省略时区时落到服务器时区
    assert.equal(schedule.timeZone, serverTimeZone())
    assert.ok(Date.parse(schedule.nextRunAt) > Date.parse(NOW))

    const read = await app.scheduler.getDailySchedule(SCOPE)
    assert.deepEqual(read, schedule)
  } finally {
    await app.dispose()
  }
})

test("setDailySchedule 传入时区时按该时区换算 next_run_at 并落库", async () => {
  const app = await setup()
  try {
    const schedule = await app.scheduler.setDailySchedule({
      ...SCOPE,
      dailyAt: "22:00",
      timeZone: "UTC",
    })
    assert.equal(schedule.timeZone, "UTC")
    // NOW = 2026-11-12T14:00Z；当天 22:00 UTC 尚未到
    assert.equal(schedule.nextRunAt, "2026-11-12T22:00:00.000Z")

    const read = await app.scheduler.getDailySchedule(SCOPE)
    assert.equal(read.timeZone, "UTC")
  } finally {
    await app.dispose()
  }
})

test("setDailySchedule 非法输入抛 invalid-input", async () => {
  const app = await setup()
  try {
    await assert.rejects(
      app.scheduler.setDailySchedule({ ...SCOPE, dailyAt: "8:00" }),
      (error) => error.code === "invalid-input",
    )
    await assert.rejects(
      app.scheduler.setDailySchedule({ ...SCOPE, dailyAt: "22:00", minPendingFast: -1 }),
      (error) => error.code === "invalid-input",
    )
    await assert.rejects(
      app.scheduler.setDailySchedule({ ...SCOPE, dailyAt: "22:00", userId: " " }),
      (error) => error.code === "invalid-input",
    )
    await assert.rejects(
      app.scheduler.setDailySchedule({ ...SCOPE, dailyAt: "22:00", timeZone: "Not/AZone" }),
      (error) => error.code === "invalid-input",
    )
  } finally {
    await app.dispose()
  }
})

test("getDailySchedule 不存在返回 null；disableSchedule 关闭并支持重设", async () => {
  const app = await setup()
  try {
    assert.equal(await app.scheduler.getDailySchedule(SCOPE), null)

    await app.scheduler.setDailySchedule({ ...SCOPE, dailyAt: "22:00" })
    await app.scheduler.disableSchedule(SCOPE)
    const disabled = await app.scheduler.getDailySchedule(SCOPE)
    assert.equal(disabled.enabled, false)

    // 重设可重新启用
    const reenabled = await app.scheduler.setDailySchedule({ ...SCOPE, dailyAt: "22:00" })
    assert.equal(reenabled.enabled, true)
  } finally {
    await app.dispose()
  }
})

test("disableSchedule 无配置抛 schedule-not-found", async () => {
  const app = await setup()
  try {
    await assert.rejects(
      app.scheduler.disableSchedule(SCOPE),
      (error) => error.code === "schedule-not-found",
    )
  } finally {
    await app.dispose()
  }
})

test("未到期调度不触发", async () => {
  const app = await setup({ pending: 5 })
  try {
    await app.scheduler.setDailySchedule({ ...SCOPE, dailyAt: "23:59", minPendingFast: 1 })
    const outcomes = await app.scheduler.runDue()
    assert.deepEqual(outcomes, [])
    assert.equal(app.daily.calls.length, 0)
  } finally {
    await app.dispose()
  }
})

test("到期但 Fast 未达阈值：当天放弃，不触发并推进到未来", async () => {
  const app = await setup({ pending: 2 })
  try {
    await app.scheduler.setDailySchedule({ ...SCOPE, dailyAt: "08:00", minPendingFast: 3 })
    await forceDue(app.database, "m1")

    const outcomes = await app.scheduler.runDue()
    assert.equal(outcomes.length, 1)
    assert.deepEqual(outcomes[0], { memorySpaceId: "m1", triggered: false, reason: "below-threshold" })
    assert.equal(app.daily.calls.length, 0)

    const after = await app.scheduler.getDailySchedule(SCOPE)
    assert.ok(Date.parse(after.nextRunAt) > Date.parse(NOW))
  } finally {
    await app.dispose()
  }
})

test("到期且达阈值：触发一次、推进 next_run_at，随后不再重复触发", async () => {
  const app = await setup({ pending: 5 })
  try {
    await app.scheduler.setDailySchedule({ ...SCOPE, dailyAt: "08:00", minPendingFast: 3 })
    await forceDue(app.database, "m1")

    const outcomes = await app.scheduler.runDue()
    assert.equal(outcomes.length, 1)
    assert.equal(outcomes[0].triggered, true)
    assert.equal(outcomes[0].batchId, "batch-1")
    assert.deepEqual(app.daily.calls, [SCOPE])

    const after = await app.scheduler.getDailySchedule(SCOPE)
    assert.ok(Date.parse(after.nextRunAt) > Date.parse(NOW))

    // 推进后不再到期，立即再跑一轮不应重复触发
    const again = await app.scheduler.runDue()
    assert.deepEqual(again, [])
    assert.equal(app.daily.calls.length, 1)
  } finally {
    await app.dispose()
  }
})

test("多个空间各自判断：只有到期且达阈值的才触发", async () => {
  const app = await setup({ pending: 5 })
  try {
    await app.scheduler.setDailySchedule({ userId: "u1", memorySpaceId: "m1", dailyAt: "08:00", minPendingFast: 3 })
    await app.scheduler.setDailySchedule({ userId: "u2", memorySpaceId: "m2", dailyAt: "08:00", minPendingFast: 10 })
    await forceDue(app.database, "m1")
    await forceDue(app.database, "m2")

    const outcomes = await app.scheduler.runDue()
    const triggered = outcomes.filter((o) => o.triggered)
    const skipped = outcomes.filter((o) => o.triggered === false)

    assert.equal(triggered.length, 1)
    assert.equal(triggered[0].memorySpaceId, "m1")
    assert.equal(skipped.length, 1)
    assert.deepEqual(skipped[0], { memorySpaceId: "m2", triggered: false, reason: "below-threshold" })
    assert.deepEqual(app.daily.calls, [{ userId: "u1", memorySpaceId: "m1" }])
  } finally {
    await app.dispose()
  }
})
