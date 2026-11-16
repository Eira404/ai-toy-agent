import type { RelationalSchemaDefinition } from "toy-storage-relational"

/** Weekly 批次主表名。 */
export const WEEKLY_BATCHES_TABLE = "toy_memory_weekly_batches"
/** Weekly 阶段可信中间结果表名。 */
export const WEEKLY_CHECKPOINTS_TABLE = "toy_memory_weekly_checkpoints"
/** Weekly 结构操作审计表名。 */
export const WEEKLY_OPS_TABLE = "toy_memory_weekly_ops"

/**
 * Weekly 包自己的逻辑表定义；由宿主合并到命名关系型 adapter 的 schema 配置。
 *
 * 三张表职责：
 * - `toy_memory_weekly_batches`：批次主记录（幂等 + 状态机 + Gate 凭证 + 前置 Daily 引用）。
 * - `toy_memory_weekly_checkpoints`：各阶段可信中间结果。
 * - `toy_memory_weekly_ops`：结构操作粗粒度审计。
 */
export const weeklyRelationalSchema = {
  tables: {
    [WEEKLY_BATCHES_TABLE]: {
      primaryKey: "weekly_batch_id",
      columns: {
        weekly_batch_id: { type: "string" },
        user_id: { type: "string" },
        memory_space_id: { type: "string" },
        status: { type: "string" },
        checkpoint_stage: { type: "integer" },
        gate_credential: { type: "string", nullable: true },
        pre_daily_batch_id: { type: "string", nullable: true },
        pre_daily_ran: { type: "boolean" },
        attempt_count: { type: "integer" },
        last_error: { type: "string", nullable: true },
        started_at: { type: "datetime", nullable: true },
        committed_at: { type: "datetime", nullable: true },
        finished_at: { type: "datetime", nullable: true },
        created_at: { type: "datetime" },
        updated_at: { type: "datetime" },
      },
      indexes: [
        { name: "weekly_batches_space_status", fields: ["memory_space_id", "status"] },
        { name: "weekly_batches_space_created", fields: ["memory_space_id", "created_at"] },
      ],
    },

    [WEEKLY_CHECKPOINTS_TABLE]: {
      primaryKey: "checkpoint_id",
      columns: {
        checkpoint_id: { type: "string" },
        batch_id: { type: "string" },
        stage: { type: "integer" },
        payload: { type: "json" },
        created_at: { type: "datetime" },
      },
      indexes: [
        { name: "weekly_checkpoints_batch_stage", fields: ["batch_id", "stage"], unique: true },
      ],
    },

    [WEEKLY_OPS_TABLE]: {
      primaryKey: "op_id",
      columns: {
        op_id: { type: "string" },
        batch_id: { type: "string" },
        memory_space_id: { type: "string" },
        block_id: { type: "string" },
        op: { type: "string" },
        related_block_ids: { type: "json" },
        created_at: { type: "datetime" },
      },
      indexes: [
        { name: "weekly_ops_batch", fields: ["batch_id"] },
        { name: "weekly_ops_space_created", fields: ["memory_space_id", "created_at"] },
      ],
    },
  },
} as const satisfies RelationalSchemaDefinition
