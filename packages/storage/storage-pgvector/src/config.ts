import type { Pool } from "pg"
import type { VectorSchemaDefinition } from "toy-storage-vector"

/** 一个命名 pgvector 数据源的连接参数和逻辑集合定义。 */
export interface PgvectorStorageConfig {
  /** 在 ctx.storage 的 vector 类别内唯一的实例名。 */
  readonly name: string
  /** PostgreSQL 连接串，通常从 DATABASE_URL 读取。 */
  readonly connectionString: string
  /** 集合、向量维度和过滤字段约束。 */
  readonly schema: VectorSchemaDefinition
  /** 集合表所在的 PostgreSQL schema，默认 public。 */
  readonly schemaName?: string
  /** 启动时创建缺失的 schema 和表，默认 false。 */
  readonly createMissing?: boolean
  /** 可注入连接池，所有权随之移交给此插件，卸载时关闭。 */
  readonly pool?: Pool
  readonly maxConnections?: number
  readonly connectionTimeoutMs?: number
  readonly idleTimeoutMs?: number
}
