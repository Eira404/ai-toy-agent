import type { RelationalSchemaDefinition } from "toy-storage-relational"
import type { VectorSchemaDefinition } from "toy-storage-vector"

/** Fast 主记录表名。 */
export const FAST_RECORDS_TABLE = "toy_memory_fast_records"
/** Fast 向量索引待办表名。 */
export const FAST_JOBS_TABLE = "toy_memory_fast_embedding_jobs"
/** Fast summary 向量集合名。 */
export const FAST_VECTOR_COLLECTION = "toy_memory_fast_vectors"

/**
 * Fast 包自己的逻辑表定义；由宿主合并到命名关系型 adapter 的 schema 配置。
 *
 * 两张表承担不同职责：
 * - `toy_memory_fast_records`：Fast 正文与来源、消费状态，追加式（正文字段不改）。
 * - `toy_memory_fast_embedding_jobs`：一次非空 Turn 提取写入的向量待办，
 *   同时以 `(memory_space_id, session_id, turn_id)` 唯一索引充当写入幂等凭据。
 */
export const fastRelationalSchema = {
  tables: {
    [FAST_RECORDS_TABLE]: {
      primaryKey: "fast_id",
      columns: {
        fast_id: { type: "string" },
        write_id: { type: "string" },
        user_id: { type: "string" },
        memory_space_id: { type: "string" },
        session_id: { type: "string" },
        turn_id: { type: "string" },
        created_at: { type: "datetime" },
        title: { type: "string" },
        title_key: { type: "string" },
        summary: { type: "string" },
        body: { type: "string" },
        consumed_batch_id: { type: "string", nullable: true },
        consumed_at: { type: "datetime", nullable: true },
      },
      indexes: [
        // 空间内“有效”标题完全匹配；consumed_batch_id IS NULL 表示未消费、可检索。
        {
          name: "fast_space_consumed_title",
          fields: ["memory_space_id", "consumed_batch_id", "title_key"],
        },
        // Session 内近期有效 Fast（提取消歧）+ listPendingForDaily 按空间取数。
        {
          name: "fast_space_session_recent",
          fields: ["memory_space_id", "session_id", "consumed_batch_id", "created_at", "fast_id"],
        },
        // runEmbeddingJobs 按 write_id 回读同批记录。
        { name: "fast_write_id", fields: ["write_id"] },
      ],
    },
    [FAST_JOBS_TABLE]: {
      primaryKey: "write_id",
      columns: {
        write_id: { type: "string" },
        user_id: { type: "string" },
        memory_space_id: { type: "string" },
        session_id: { type: "string" },
        turn_id: { type: "string" },
        status: { type: "string" },
        attempts: { type: "integer" },
        next_attempt_at: { type: "datetime" },
        lease_token: { type: "string", nullable: true },
        lease_until: { type: "datetime", nullable: true },
        last_error: { type: "string", nullable: true },
        created_at: { type: "datetime" },
        updated_at: { type: "datetime" },
      },
      indexes: [
        // 同一 Turn 只接受一次写入批次，并发重试据此决出已提交结果。
        {
          name: "fast_jobs_space_session_turn",
          fields: ["memory_space_id", "session_id", "turn_id"],
          unique: true,
        },
        // worker 按状态与下次可执行时间认领待办。
        { name: "fast_jobs_status_next", fields: ["status", "next_attempt_at"] },
      ],
    },
  },
} as const satisfies RelationalSchemaDefinition

/**
 * 构造 Fast 向量集合定义；`dimensions` 必须与所选 Embedding 模型输出维度一致，
 * 由宿主在装配时确定并合并到向量 adapter。
 *
 * 向量记录 ID 使用 `fast_id`，命中后回关系表读取正文并校验消费状态。
 */
export function defineFastVectorSchema(dimensions: number): VectorSchemaDefinition {
  return {
    collections: {
      [FAST_VECTOR_COLLECTION]: {
        dimensions,
        metric: "cosine",
        filterFields: { userId: "string", memorySpaceId: "string" },
      },
    },
  }
}
