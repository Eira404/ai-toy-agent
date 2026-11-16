import type { RelationalSchemaDefinition } from "toy-storage-relational"
import type { VectorSchemaDefinition } from "toy-storage-vector"
import { spaceRelationalSchema } from "toy-memory-space"
import { fastRelationalSchema, defineFastVectorSchema } from "toy-memory-fast"
import { longRelationalSchema, defineLongVectorSchema } from "toy-memory-long"
import { feedbackRelationalSchema } from "toy-memory-feedback"
import { dailyRelationalSchema } from "toy-memory-daily"
import { adminAuthRelationalSchema } from "toy-admin-auth"
import { adminRelationalSchema } from "toy-admin"

/**
 * 合并 admin 后端需要的关系型 Schema。
 *
 * 浏览用「空间 + Fast + Long」之外，管理员手动触发 Daily 还需要 daily 的批次/
 * checkpoint/空间状态表与 feedback 的态度表；管理员账号/会话/审计照旧。
 */
export function buildRelationalSchema(): RelationalSchemaDefinition {
  return {
    tables: {
      ...spaceRelationalSchema.tables,
      ...fastRelationalSchema.tables,
      ...longRelationalSchema.tables,
      ...dailyRelationalSchema.tables,
      ...feedbackRelationalSchema.tables,
      ...adminAuthRelationalSchema.tables,
      ...adminRelationalSchema.tables,
    },
  }
}

/** 合并 Fast / Long 的向量集合定义，`dimensions` 必须与 Embedding 模型一致。 */
export function buildVectorSchema(embeddingDimensions: number): VectorSchemaDefinition {
  return {
    collections: {
      ...defineFastVectorSchema(embeddingDimensions).collections,
      ...defineLongVectorSchema(embeddingDimensions).collections,
    },
  }
}
