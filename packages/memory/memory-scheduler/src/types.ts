import type { Scope } from "toy-memory-fast"

/**
 * `toy-memory-scheduler` 的公共类型契约。
 *
 * 调度配置按「记忆空间」一份（与 Daily 的运行粒度一致）。调度器只负责决定
 * 「何时、对谁、是否满足阈值地」调用 `memoryDaily.runDaily`，不解析记忆内容。
 */

/** 调度任务类型；当前只有 daily，未来扩展 weekly。 */
export type ScheduleKind = "daily"

/** 一个空间的 daily 调度配置，与 `toy_memory_schedules` 行一一对应（camelCase）。 */
export interface DailySchedule {
  readonly memorySpaceId: string
  readonly userId: string
  readonly kind: ScheduleKind
  /** 是否启用；关闭后调度器不再扫描它。 */
  readonly enabled: boolean
  /** 每天触发钟点，24 小时制 "HH:mm"。 */
  readonly dailyAt: string
  /** 触发钟点所在 IANA 时区（如 "Asia/Shanghai"）；null 表示按服务器时区。 */
  readonly timeZone: string | null
  /** 触发阈值：未消费 Fast ≥ 此值才启动；默认 1。 */
  readonly minPendingFast: number
  /** 上次调度触发时间（含失败/放弃），从未触发为 null。 */
  readonly lastTriggeredAt: string | null
  /** 下一次计划触发时间，从未设置或待重算为 null。 */
  readonly nextRunAt: string | null
  readonly createdAt: string
  readonly updatedAt: string
}

/** 设置/更新 daily 调度的输入。 */
export interface SetDailyScheduleInput {
  readonly userId: string
  readonly memorySpaceId: string
  /** 每天触发钟点，24 小时制 "HH:mm"。 */
  readonly dailyAt: string
  /** 触发钟点所在 IANA 时区；省略按服务器时区。 */
  readonly timeZone?: string
  /** 触发阈值，默认 1。 */
  readonly minPendingFast?: number
  /** 是否启用，默认 true。 */
  readonly enabled?: boolean
}

/** 一轮扫描中某个到期调度的处理结果。 */
export type SweepOutcome =
  | { readonly memorySpaceId: string; readonly triggered: true; readonly batchId: string }
  | {
      readonly memorySpaceId: string
      readonly triggered: false
      readonly reason: "below-threshold" | "claim-lost"
    }

/** 调度器最小依赖：daily 执行器。 */
export interface DailyRunner {
  runDaily(scope: Scope): Promise<{ readonly batchId: string }>
}

/** 调度器最小依赖：Fast 待整合计数。 */
export interface FastCounter {
  countBySpace(scope: Scope): Promise<{ readonly pending: number }>
}
