import type { RelationalSchemaDefinition } from "toy-storage-relational"

/** 记忆空间主表名。 */
export const SPACES_TABLE = "toy_memory_spaces"
/** 娃娃-空间绑定表名。 */
export const DEVICES_TABLE = "toy_memory_space_devices"

/**
 * Space 包自己的逻辑表定义；由宿主合并到命名关系型 adapter 的 schema 配置。
 *
 * - `toy_memory_spaces`：空间主表。`status` 是软删除标记（active/deleted），
 *   删除只改状态、不删绑定，天然支持恢复。
 * - `toy_memory_space_devices`：娃娃绑定表。`(user_id, device_id)` 唯一索引
 *   保证一个娃娃只绑定一个空间；`memory_space_id` 索引用于列空间下的娃娃。
 */
export const spaceRelationalSchema = {
  tables: {
    [SPACES_TABLE]: {
      primaryKey: "memory_space_id",
      columns: {
        memory_space_id: { type: "string" },
        user_id: { type: "string" },
        name: { type: "string", nullable: true },
        status: { type: "string" },
        created_at: { type: "datetime" },
        updated_at: { type: "datetime" },
      },
      indexes: [
        // 列出某用户的 active 空间（含已删时也走 user_id 前缀）。
        { name: "memory_spaces_user_status_created", fields: ["user_id", "status", "created_at"] },
      ],
    },
    [DEVICES_TABLE]: {
      primaryKey: "binding_id",
      columns: {
        binding_id: { type: "string" },
        user_id: { type: "string" },
        device_id: { type: "string" },
        memory_space_id: { type: "string" },
        created_at: { type: "datetime" },
      },
      indexes: [
        // 一个娃娃只绑定一个空间。
        { name: "memory_space_devices_user_device", fields: ["user_id", "device_id"], unique: true },
        // 列出某空间下的全部娃娃。
        { name: "memory_space_devices_space", fields: ["memory_space_id"] },
      ],
    },
  },
} as const satisfies RelationalSchemaDefinition
