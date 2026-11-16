import type { RelationalSchemaDefinition } from "toy-storage-relational"
import type { VectorSchemaDefinition } from "toy-storage-vector"
import { spaceRelationalSchema } from "toy-memory-space"
import { fastRelationalSchema, defineFastVectorSchema } from "toy-memory-fast"
import { longRelationalSchema, defineLongVectorSchema } from "toy-memory-long"
import { feedbackRelationalSchema } from "toy-memory-feedback"
import { dailyRelationalSchema } from "toy-memory-daily"
import { schedulerRelationalSchema } from "toy-memory-scheduler"

/**
 * 合并记忆系统各包导出的关系型 Schema，得到 Go 记忆后端使用的完整目标态。
 *
 * 与 `apps/backend` 的区别：本后端只服务记忆读写与 Daily，不含 Session /
 * 用户 / 设备等表；新增 `schedulerRelationalSchema` 以支撑 `MemoryScheduler`
 * 的 daily 调度配置表。
 */
export function buildRelationalSchema(): RelationalSchemaDefinition {
  return {
    tables: {
      ...spaceRelationalSchema.tables,
      ...fastRelationalSchema.tables,
      ...longRelationalSchema.tables,
      ...dailyRelationalSchema.tables,
      ...feedbackRelationalSchema.tables,
      ...schedulerRelationalSchema.tables,
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
