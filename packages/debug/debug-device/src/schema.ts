import type { RelationalSchemaDefinition } from "toy-storage-relational"

/** Debug 设备（娃娃）主表名。 */
export const DEVICES_TABLE = "toy_devices"

/**
 * Debug 设备（娃娃）表的逻辑表定义；由宿主合并到命名关系型 adapter 的 schema 配置。
 *
 * `user_id` 可空表示设备尚未绑定用户；`(user_id, created_at)` 索引用于列出某用户下的设备。
 * `persona` 是玩偶人设文本，`age` 是使用该玩偶的孩子年龄（一个用户可有多个玩偶，分别设置）。
 */
export const devicesRelationalSchema = {
  tables: {
    [DEVICES_TABLE]: {
      primaryKey: "device_id",
      columns: {
        device_id: { type: "string" },
        user_id: { type: "string", nullable: true },
        display_name: { type: "string", nullable: true },
        note: { type: "string", nullable: true },
        persona: { type: "string", nullable: true },
        age: { type: "integer", nullable: true },
        payload: { type: "json", nullable: true },
        created_at: { type: "datetime" },
        updated_at: { type: "datetime" },
      },
      indexes: [
        { name: "devices_user_created", fields: ["user_id", "created_at"] },
        { name: "devices_created", fields: ["created_at"] },
      ],
    },
  },
} as const satisfies RelationalSchemaDefinition
