import type { RelationalSchemaDefinition } from "toy-storage-relational"

/** Session 包自己的逻辑表定义；由宿主合并到命名关系型 adapter 的 schema 配置。 */
export const sessionRelationalSchema = {
  tables: {
    toy_sessions: {
      primaryKey: "session_id",
      columns: {
        session_id: { type: "string" },
        user_id: { type: "string" },
        device_id: { type: "string" },
        status: { type: "string" },
        payload: { type: "json" },
        version: { type: "integer" },
        created_at: { type: "datetime" },
        closing_at: { type: "datetime", nullable: true },
        closed_at: { type: "datetime", nullable: true },
      },
      indexes: [
        { name: "user_device_created", fields: ["user_id", "device_id", "created_at"] },
        { name: "user_device_status", fields: ["user_id", "device_id", "status"] },
      ],
    },
    toy_session_turns: {
      primaryKey: "turn_id",
      columns: {
        turn_id: { type: "string" },
        session_id: { type: "string" },
        turn_no: { type: "integer" },
        started_at: { type: "datetime" },
      },
      indexes: [{ name: "session_turn_no", fields: ["session_id", "turn_no"], unique: true }],
    },
    toy_session_events: {
      primaryKey: "event_id",
      columns: {
        event_id: { type: "string" },
        session_id: { type: "string" },
        turn_id: { type: "string" },
        sequence: { type: "integer" },
        event_type: { type: "string" },
        payload: { type: "json" },
        version: { type: "integer" },
        occurred_at: { type: "datetime" },
      },
      indexes: [
        { name: "session_sequence", fields: ["session_id", "sequence"], unique: true },
        { name: "turn_sequence", fields: ["turn_id", "sequence"] },
      ],
    },
  },
} as const satisfies RelationalSchemaDefinition
