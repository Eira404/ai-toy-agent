import type { RelationalSchemaDefinition } from "toy-storage-relational"

/** Daily 批次主表名。 */
export const DAILY_BATCHES_TABLE = "toy_memory_daily_batches"
/** Daily 阶段可信中间结果表名。 */
export const DAILY_CHECKPOINTS_TABLE = "toy_memory_daily_checkpoints"
/** Daily 阶段八运维审计表名。 */
export const DAILY_AUDITS_TABLE = "toy_memory_daily_target_audits"
/** Daily 空间级状态表名（成功 Daily 计数，供 Weekly 防饥饿）。 */
export const DAILY_SPACE_STATE_TABLE = "toy_memory_daily_space_state"

/**
 * Daily 包自己的逻辑表定义；由宿主合并到命名关系型 adapter 的 schema 配置。
 *
 * 四张表职责：
 * - `toy_memory_daily_batches`：批次主记录（幂等 + 状态机 + Gate 凭证 +
 *   冻结范围 + 衰减开关）。
 * - `toy_memory_daily_checkpoints`：各阶段可信中间结果，整体失败时从最后一个
 *   可信阶段重试。
 * - `toy_memory_daily_target_audits`：阶段八按目标块的运维审计
 *   （sourceFastIds + APPLY/LOCAL_ABANDON）。
 * - `toy_memory_daily_space_state`：空间级状态（成功 Daily 计数供 Weekly
 *   防饥饿，时间戳防同一天重复触发）。
 */
export const dailyRelationalSchema = {
  tables: {
    [DAILY_BATCHES_TABLE]: {
      primaryKey: "batch_id",
      columns: {
        batch_id: { type: "string" },
        user_id: { type: "string" },
        memory_space_id: { type: "string" },
        // waiting_gate / running / committing / reconciling / succeeded / failed / abandoned
        status: { type: "string" },
        // 已固化的最高可信阶段：0=冻结，1=阶段零，2..9=阶段一..八
        checkpoint_stage: { type: "integer" },
        gate_credential: { type: "string", nullable: true },
        frozen_fast_count: { type: "integer" },
        frozen_turn_count: { type: "integer" },
        // 本批是否推进一个衰减周期（冻结 turn 数达活动阈值才 true）
        decay_enabled: { type: "boolean" },
        attempt_count: { type: "integer" },
        last_error: { type: "string", nullable: true },
        frozen_at: { type: "datetime", nullable: true },
        started_at: { type: "datetime", nullable: true },
        committed_at: { type: "datetime", nullable: true },
        finished_at: { type: "datetime", nullable: true },
        created_at: { type: "datetime" },
        updated_at: { type: "datetime" },
      },
      indexes: [
        // 查空间内未完成批次；「同空间只允许一个未完成 Daily」由应用层 + Gate 保证
        { name: "daily_batches_space_status", fields: ["memory_space_id", "status"] },
        // 运维按空间浏览批次
        { name: "daily_batches_space_created", fields: ["memory_space_id", "created_at"] },
      ],
    },

    [DAILY_CHECKPOINTS_TABLE]: {
      // 确定性主键 `${batch_id}:${stage}`，重试覆盖写同一行，天然幂等
      primaryKey: "checkpoint_id",
      columns: {
        checkpoint_id: { type: "string" },
        batch_id: { type: "string" },
        stage: { type: "integer" },
        payload: { type: "json" },
        created_at: { type: "datetime" },
      },
      indexes: [
        // 一个 batch + 阶段只保留一行；按 batch 顺序读全部阶段
        { name: "daily_checkpoints_batch_stage", fields: ["batch_id", "stage"], unique: true },
      ],
    },

    [DAILY_AUDITS_TABLE]: {
      primaryKey: "audit_id",
      columns: {
        audit_id: { type: "string" },
        batch_id: { type: "string" },
        memory_space_id: { type: "string" },
        // 目标块 ID：APPLY 为最终 blockId；LOCAL_ABANDON 时可能为 old blockId 或 null
        target_block_id: { type: "string", nullable: true },
        // APPLY / LOCAL_ABANDON
        result: { type: "string" },
        // 该目标 sourceFastIds 并集（粗粒度来源池，只审计不进正文）
        source_fast_ids: { type: "json" },
        created_at: { type: "datetime" },
      },
      indexes: [
        { name: "daily_audits_batch", fields: ["batch_id"] },
        { name: "daily_audits_space_created", fields: ["memory_space_id", "created_at"] },
      ],
    },

    [DAILY_SPACE_STATE_TABLE]: {
      primaryKey: "memory_space_id",
      columns: {
        memory_space_id: { type: "string" },
        user_id: { type: "string" },
        // 上次成功 Weekly 之后成功提交的 Daily 数（Weekly 防饥饿 N=3，Weekly 成功后清零）
        successful_daily_count: { type: "integer" },
        // 最近一次 Daily 触发时间（含失败/放弃，防同一天重复触发）
        last_daily_at: { type: "datetime", nullable: true },
        last_weekly_at: { type: "datetime", nullable: true },
        created_at: { type: "datetime" },
        updated_at: { type: "datetime" },
      },
      // 单行表，PK 即定位，无需二级索引
      indexes: [],
    },
  },
} as const satisfies RelationalSchemaDefinition
