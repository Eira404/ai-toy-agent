import type { RelationalSchemaDefinition } from "toy-storage-relational"

/** Debug 用户主表名。 */
export const USERS_TABLE = "toy_users"

/**
 * Debug 用户表的逻辑表定义；由宿主合并到命名关系型 adapter 的 schema 配置。
 *
 * 仅用于 debug：补上项目目前缺失的「用户」实体，方便在数据库里按 userId
 * 核对、备注和附加结构化数据。生产环境的用户数据仍由其他系统负责，本表不参与鉴权。
 */
export const usersRelationalSchema = {
  tables: {
    [USERS_TABLE]: {
      primaryKey: "user_id",
      columns: {
        user_id: { type: "string" },
        display_name: { type: "string", nullable: true },
        note: { type: "string", nullable: true },
        payload: { type: "json", nullable: true },
        created_at: { type: "datetime" },
        updated_at: { type: "datetime" },
      },
      indexes: [{ name: "users_created", fields: ["created_at"] }],
    },
  },
} as const satisfies RelationalSchemaDefinition
