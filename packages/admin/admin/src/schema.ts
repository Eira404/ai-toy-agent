import type { RelationalSchemaDefinition } from "toy-storage-relational"

export const ADMIN_OPERATIONS_TABLE = "toy_admin_operations"

/** 调用审计表，不是任务表。宿主须将本定义合并到自己的关系型 schema。 */
export const adminRelationalSchema = {
  tables: {
    [ADMIN_OPERATIONS_TABLE]: {
      primaryKey: "execution_id",
      columns: {
        execution_id: { type: "string" },
        request_id: { type: "string" },
        operation_name: { type: "string" },
        registration_id: { type: "string", nullable: true },
        admin_id: { type: "string", nullable: true },
        admin_role: { type: "string", nullable: true },
        operation_kind: { type: "string", nullable: true },
        status: { type: "string" },
        execution_state: { type: "string" },
        wait_status: { type: "string" },
        error_code: { type: "string", nullable: true },
        started_at: { type: "datetime" },
        finished_at: { type: "datetime", nullable: true },
        duration_ms: { type: "integer", nullable: true },
        summary: { type: "json", nullable: true },
      },
      indexes: [
        { name: "admin_operation_started", fields: ["started_at", "execution_id"] },
        { name: "admin_operation_actor", fields: ["admin_id", "started_at"] },
      ],
    },
  },
} as const satisfies RelationalSchemaDefinition
