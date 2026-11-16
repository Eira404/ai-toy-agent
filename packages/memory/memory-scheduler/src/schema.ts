import type { RelationalSchemaDefinition } from "toy-storage-relational"

/** 调度配置表名：每个记忆空间一行。 */
export const SCHEDULES_TABLE = "toy_memory_schedules"

/**
 * Scheduler 包自己的逻辑表定义；由宿主合并到命名关系型 adapter 的 schema 配置。
 *
 * 每个记忆空间一条调度（PK = memory_space_id）。当前只支持 daily（每天一个钟点），
 * `time_zone` 存触发钟点所在的 IANA 时区（省略按服务器时区），未来 weekly 可在此基础上
 * 加星期几字段或升级为 cron。`next_run_at` 是调度器扫描的依据：到期且待整合 Fast 达
 * 阈值才真正触发，触发或「当天放弃」后都推进到下一个计划点。
 */
export const schedulerRelationalSchema = {
  tables: {
    [SCHEDULES_TABLE]: {
      primaryKey: "memory_space_id",
      columns: {
        memory_space_id: { type: "string" },
        user_id: { type: "string" },
        // daily（未来：weekly）
        kind: { type: "string" },
        enabled: { type: "boolean" },
        // 每天触发钟点，24 小时制 "HH:mm"
        daily_at: { type: "string" },
        // 触发钟点所在 IANA 时区；null = 按服务器时区
        time_zone: { type: "string", nullable: true },
        // 触发阈值：未消费 Fast ≥ 此值才启动
        min_pending_fast: { type: "integer" },
        // 上次调度触发时间（含失败/放弃，用于观测）
        last_triggered_at: { type: "datetime", nullable: true },
        // 下一次计划触发时间；调度器据此扫描到期任务
        next_run_at: { type: "datetime", nullable: true },
        created_at: { type: "datetime" },
        updated_at: { type: "datetime" },
      },
      indexes: [
        // 扫描「启用的到期调度」
        { name: "memory_schedules_due", fields: ["enabled", "next_run_at"] },
      ],
    },
  },
} as const satisfies RelationalSchemaDefinition
