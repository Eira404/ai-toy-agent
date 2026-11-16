import type { RelationalSchemaDefinition } from "toy-storage-relational"

/** 反馈表名。 */
export const FEEDBACK_TABLE = "toy_memory_feedback_entries"

/**
 * 记忆反馈包自己的逻辑表定义；由宿主合并到命名关系型 adapter 的 schema 配置。
 *
 * - 唯一索引 `feedback_session_unit` 保证同一 Session 内每个价值单元只有一条反馈（幂等键）。
 * - `feedback_pending` 供 Daily 按空间读取未巩固反馈。
 * - `feedback_unit` 供 Daily 按价值单元聚合跨 Session 反馈。
 */
export const feedbackRelationalSchema = {
  tables: {
    [FEEDBACK_TABLE]: {
      primaryKey: "feedback_id",
      columns: {
        feedback_id: { type: "string" },
        user_id: { type: "string" },
        memory_space_id: { type: "string" },
        session_id: { type: "string" },
        unit_type: { type: "string" },
        unit_id: { type: "string" },
        block_id: { type: "string" },
        feedback_type: { type: "string" },
        evidence_turn_nos: { type: "json" },
        recall_turn_nos: { type: "json" },
        judgement_data: { type: "json" },
        judgement_version: { type: "integer" },
        consumed_batch_id: { type: "string", nullable: true },
        consumed_at: { type: "datetime", nullable: true },
        created_at: { type: "datetime" },
        updated_at: { type: "datetime" },
      },
      indexes: [
        {
          name: "feedback_session_unit",
          fields: ["memory_space_id", "session_id", "unit_type", "unit_id"],
          unique: true,
        },
        { name: "feedback_pending", fields: ["memory_space_id", "consumed_batch_id"] },
        { name: "feedback_unit", fields: ["memory_space_id", "unit_type", "unit_id"] },
      ],
    },
  },
} as const satisfies RelationalSchemaDefinition
