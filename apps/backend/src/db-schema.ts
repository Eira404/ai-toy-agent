import type { RelationalSchemaDefinition } from "toy-storage-relational"
import type { VectorSchemaDefinition } from "toy-storage-vector"
import { sessionRelationalSchema } from "toy-session-storage"
import { spaceRelationalSchema } from "toy-memory-space"
import { fastRelationalSchema, defineFastVectorSchema } from "toy-memory-fast"
import { longRelationalSchema, defineLongVectorSchema } from "toy-memory-long"
import { feedbackRelationalSchema } from "toy-memory-feedback"
import { dailyRelationalSchema } from "toy-memory-daily"
import { usersRelationalSchema } from "toy-debug-user"
import { devicesRelationalSchema } from "toy-debug-device"

/**
 * 合并各业务包导出的关系型 Schema，得到后端使用的完整目标态。
 *
 * 后端装配与数据库迁移（`toy-storage-migrate`）共用这一份，保证两边看到的是同一个结构。
 */
export function buildRelationalSchema(options: { readonly debugBackend: boolean }): RelationalSchemaDefinition {
  return {
    tables: {
      ...sessionRelationalSchema.tables,
      ...spaceRelationalSchema.tables,
      ...fastRelationalSchema.tables,
      ...longRelationalSchema.tables,
      ...dailyRelationalSchema.tables,
      ...feedbackRelationalSchema.tables,
      ...(options.debugBackend ? usersRelationalSchema.tables : {}),
      ...(options.debugBackend ? devicesRelationalSchema.tables : {}),
    },
  }
}

/** 合并 Fast / Long 的向量集合定义，`dimensions` 必须与所选 Embedding 模型一致。 */
export function buildVectorSchema(embeddingDimensions: number): VectorSchemaDefinition {
  return {
    collections: {
      ...defineFastVectorSchema(embeddingDimensions).collections,
      ...defineLongVectorSchema(embeddingDimensions).collections,
    },
  }
}
