import type { RelationalSchemaDefinition } from "toy-storage-relational"
import type { Pool } from "pg"

/** 插件实例对应一个命名 PostgreSQL 数据源。 */
export interface PostgresStorageConfig {
  readonly name: string
  readonly connectionString: string
  readonly schema: RelationalSchemaDefinition
  /** 可注入已有连接池；插件卸载时会关闭它。主要用于测试或外部连接池装配。 */
  readonly pool?: Pool
  /** PostgreSQL schema 名称；默认 public。 */
  readonly schemaName?: string
  /** 启动时创建缺失的表和索引；默认 false，不执行迁移。 */
  readonly createMissing?: boolean
  readonly maxConnections?: number
  readonly connectionTimeoutMs?: number
  readonly idleTimeoutMs?: number
}
