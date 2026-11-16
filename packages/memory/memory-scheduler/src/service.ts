import { Service, type Context } from "cordis"
import "toy-storage"
import "toy-memory-fast"
import "toy-memory-daily"
import type { RelationalAdapter } from "toy-storage-relational"
import type { Scope } from "toy-memory-fast"
import type { DailyRunResult } from "toy-memory-daily"
import {
  resolveSchedulerConfig,
  type ResolvedSchedulerConfig,
  type SchedulerConfig,
} from "./config.js"
import { SchedulerError } from "./error.js"
import {
  andWhere,
  assertSchedulerSchema,
  eq,
  lte,
  scheduleFromRow,
  scheduleRow,
} from "./relational.js"
import { SCHEDULES_TABLE } from "./schema.js"
import {
  isValidTimeZone,
  nextDailyOccurrence,
  parseDailyAt,
  serverTimeZone,
} from "./time.js"
import type { DailySchedule, SetDailyScheduleInput, SweepOutcome } from "./types.js"

declare module "cordis" {
  interface Context {
    memoryScheduler: MemoryScheduler
  }
}

/**
 * 记忆定时任务调度服务。
 *
 * 职责：维护每个记忆空间的 daily 调度配置，按周期扫描「到期且待整合 Fast 达阈值」
 * 的调度，调用 `memoryDaily.runDaily`。本包不解析记忆内容，也不实现 Dream Gate
 * （Gate 属于会话层 Runtime，由宿主导入并注册到 `memoryDaily`）。
 *
 * 多实例安全：触发前用数据库条件更新抢占 `next_run_at`，只有抢到的实例真正运行。
 * 阈值未达到时「当天放弃」——直接把 `next_run_at` 推进到下一个计划点，不在当天反复判断。
 *
 * 依赖：`storage`（关系型，存调度配置）、`memoryDaily`（执行一次 Daily）、
 * `memoryFast`（`countBySpace` 判断待整合 Fast 阈值）。
 */
export class MemoryScheduler extends Service {
  static inject = ["storage", "memoryDaily", "memoryFast"]

  private readonly config: ResolvedSchedulerConfig
  private relational: RelationalAdapter | undefined
  private timer: ReturnType<typeof setInterval> | undefined

  constructor(ctx: Context, config: SchedulerConfig = {}) {
    super(ctx, "memoryScheduler")
    this.config = resolveSchedulerConfig(config)
    ctx.effect(() => () => this.stop(), "memoryScheduler.stop")
  }

  /** 核对命名存储实例、校验表结构，并启动后台扫描。 */
  [Service.init](): void {
    const relational = this.ctx.storage.tryGet<RelationalAdapter>(
      "relational",
      this.config.relationalSource,
    )
    if (relational === undefined) {
      throw new SchedulerError(
        "source-not-ready",
        `关系型存储实例 'relational/${this.config.relationalSource}' 尚未就绪`,
      )
    }
    assertSchedulerSchema(relational)
    this.relational = relational
    this.start()
  }

  /**
   * 设置/更新一个空间的 daily 调度（整行 upsert）。
   *
   * 传入的 `dailyAt` 是墙钟时间，`timeZone`（可选）是它所在的 IANA 时区；省略时按
   * 服务器时区。二者一起换算成服务器绝对时间写入 `next_run_at`。
   *
   * @param input 空间归属、触发钟点、可选时区/阈值/开关。
   * @returns 落库后的完整调度。
   */
  async setDailySchedule(input: SetDailyScheduleInput): Promise<DailySchedule> {
    assertNonEmpty(input.userId, "userId")
    assertNonEmpty(input.memorySpaceId, "memorySpaceId")
    if (parseDailyAt(input.dailyAt) === null) {
      throw new SchedulerError("invalid-input", "dailyAt 必须是 HH:mm（24 小时制）")
    }
    const minPendingFast = input.minPendingFast ?? 1
    if (!Number.isSafeInteger(minPendingFast) || minPendingFast < 0) {
      throw new SchedulerError("invalid-input", "minPendingFast 必须是非负安全整数")
    }
    const timeZone = resolveTimeZone(input.timeZone)
    const dailyAt = input.dailyAt.trim()

    const now = this.config.now()
    const current = await this.getDailySchedule({
      userId: input.userId,
      memorySpaceId: input.memorySpaceId,
    })
    const schedule: DailySchedule = {
      memorySpaceId: input.memorySpaceId,
      userId: input.userId,
      kind: "daily",
      enabled: input.enabled ?? true,
      dailyAt,
      timeZone,
      minPendingFast,
      lastTriggeredAt: current?.lastTriggeredAt ?? null,
      nextRunAt: nextDailyOccurrence(new Date(now), dailyAt, timeZone),
      createdAt: current?.createdAt ?? now,
      updatedAt: now,
    }
    await this.requireRelational().execute({
      type: "upsert",
      table: SCHEDULES_TABLE,
      value: scheduleRow(schedule),
    })
    return schedule
  }

  /** 读一个空间的 daily 调度，不存在返回 null。 */
  async getDailySchedule(scope: Scope): Promise<DailySchedule | null> {
    const result = await this.requireRelational().execute({
      type: "get",
      table: SCHEDULES_TABLE,
      key: scope.memorySpaceId,
    })
    return result.row === undefined ? null : scheduleFromRow(result.row)
  }

  /** 关闭一个空间的调度（保留配置，`setDailySchedule` 可重新启用）。 */
  async disableSchedule(scope: Scope): Promise<void> {
    const now = this.config.now()
    const result = await this.requireRelational().execute({
      type: "update",
      table: SCHEDULES_TABLE,
      where: eq("memory_space_id", scope.memorySpaceId),
      patch: { enabled: false, updated_at: now },
    })
    if (result.affectedRows === 0) {
      throw new SchedulerError("schedule-not-found", `空间 '${scope.memorySpaceId}' 没有调度配置`)
    }
  }

  /**
   * 手动触发一轮扫描（供测试/运维），按到期时间升序处理所有到期调度。
   *
   * 只返回本轮到期调度的处理结果（未到期的不在内）。后台定时器也会调用本方法。
   *
   * @returns 逐项处理结果；`triggered: false` 表示阈值未达或抢锁失败。
   */
  async runDue(): Promise<readonly SweepOutcome[]> {
    const relational = this.requireRelational()
    const now = this.config.now()
    const due = await relational.execute({
      type: "find",
      table: SCHEDULES_TABLE,
      where: andWhere([eq("enabled", true), lte("next_run_at", now)]),
      orderBy: [{ field: "next_run_at", direction: "asc" }],
    })
    const schedules = due.rows.map(scheduleFromRow)
    return mapLimit(schedules, this.config.maxConcurrentRuns, (schedule) =>
      this.processDue(schedule, now),
    )
  }

  /** 处理单个到期调度：判阈值 → 原子抢占 → 触发。 */
  private async processDue(schedule: DailySchedule, now: string): Promise<SweepOutcome> {
    const relational = this.requireRelational()
    const scope = { userId: schedule.userId, memorySpaceId: schedule.memorySpaceId }
    const memorySpaceId = schedule.memorySpaceId

    // ① 阈值判断：待整合 Fast 不足则「当天放弃」，推进到下一个计划点。
    const count = await this.ctx.memoryFast.countBySpace(scope)
    if (count.pending < schedule.minPendingFast) {
      await this.advance(schedule, now)
      return { memorySpaceId, triggered: false, reason: "below-threshold" }
    }

    // ② 原子抢占：多实例只有一人能推进 next_run_at，抢到的才触发。
    const previous = schedule.nextRunAt
    if (previous === null) {
      return { memorySpaceId, triggered: false, reason: "claim-lost" }
    }
    const nextRunAt = this.nextRunAt(schedule, now)
    const claimed = await relational.execute({
      type: "update",
      table: SCHEDULES_TABLE,
      where: andWhere([eq("memory_space_id", memorySpaceId), eq("next_run_at", previous)]),
      patch: { next_run_at: nextRunAt, last_triggered_at: now, updated_at: now },
    })
    if (claimed.affectedRows === 0) {
      return { memorySpaceId, triggered: false, reason: "claim-lost" }
    }

    // ③ 触发一次 Daily。
    const result: DailyRunResult = await this.ctx.memoryDaily.runDaily(scope)
    return { memorySpaceId, triggered: true, batchId: result.batchId }
  }

  /** 把 next_run_at 推进到下一个计划点（不触发）。 */
  private async advance(schedule: DailySchedule, now: string): Promise<void> {
    await this.requireRelational().execute({
      type: "update",
      table: SCHEDULES_TABLE,
      where: eq("memory_space_id", schedule.memorySpaceId),
      patch: { next_run_at: this.nextRunAt(schedule, now), updated_at: now },
    })
  }

  /** 按调度自己的钟点与时区计算下一个计划点（省略时区按服务器时区）。 */
  private nextRunAt(schedule: DailySchedule, now: string): string {
    const timeZone = schedule.timeZone ?? serverTimeZone()
    return nextDailyOccurrence(new Date(now), schedule.dailyAt, timeZone)
  }

  /** 启动后台扫描定时器。 */
  private start(): void {
    if (this.timer !== undefined) {
      return
    }
    this.timer = setInterval(() => {
      void this.runDue().catch((error: unknown) => {
        this.ctx.logger.warn("memoryScheduler 扫描失败", error)
      })
    }, this.config.scheduleTickMs)
  }

  /** 停止后台扫描定时器（Cordis 卸载时由 effect 调用）。 */
  private stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer)
      this.timer = undefined
    }
  }

  private requireRelational(): RelationalAdapter {
    if (this.relational === undefined) {
      throw new SchedulerError("source-not-ready", "关系型存储实例尚未初始化")
    }
    return this.relational
  }
}

export default MemoryScheduler

// ---------------------------------------------------------------------------
// 模块级辅助
// ---------------------------------------------------------------------------

/** 以 `limit` 并发度依次处理 `items`，保持结果顺序与输入一致。 */
async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array<R>(items.length)
  let next = 0
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = next
      next += 1
      if (index >= items.length) {
        return
      }
      const item = items[index]
      if (item === undefined) {
        return
      }
      results[index] = await worker(item)
    }
  })
  await Promise.all(runners)
  return results
}

function assertNonEmpty(value: string, name: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new SchedulerError("invalid-input", `${name} 必须是非空字符串`)
  }
}

/** 解析输入的时区：省略用服务器时区，传入则校验为合法 IANA 时区。 */
function resolveTimeZone(value: string | undefined): string {
  if (value === undefined) {
    return serverTimeZone()
  }
  const trimmed = value.trim()
  if (trimmed.length === 0 || !isValidTimeZone(trimmed)) {
    throw new SchedulerError("invalid-input", `timeZone '${value}' 不是合法的 IANA 时区`)
  }
  return trimmed
}
