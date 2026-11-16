import type { RelationalSchemaDefinition } from "toy-storage-relational"
import type { VectorSchemaDefinition } from "toy-storage-vector"

/** Long 记忆块主表名。 */
export const LONG_BLOCKS_TABLE = "toy_memory_long_blocks"
/** Long 细节补充表名。 */
export const LONG_DETAILS_TABLE = "toy_memory_long_details"
/** Long 别名表名。 */
export const LONG_ALIASES_TABLE = "toy_memory_long_aliases"
/** Long 关键词表名（预留，当前不生成不检索）。 */
export const LONG_KEYWORDS_TABLE = "toy_memory_long_keywords"
/** Long summary 向量集合名（块 summary 与细节 summary 平级存放）。 */
export const LONG_VECTOR_COLLECTION = "toy_memory_long_vectors"

/**
 * Long 包自己的逻辑表定义；由宿主合并到命名关系型 adapter 的 schema 配置。
 *
 * 四张表承担不同职责：
 * - `toy_memory_long_blocks`：记忆块主表，含 Domain、title/aliases、summary、
 *   当下概括正文，以及当下概括的价值状态（价值状态以 version + opaque JSON 封装）。
 * - `toy_memory_long_details`：细节补充，每条是独立价值单元，`detailId` 即单元 ID。
 * - `toy_memory_long_aliases`：别名，供 title/alias 规范化完全匹配。
 * - `toy_memory_long_keywords`：预留，MVP 不生成、不检索。
 */
export const longRelationalSchema = {
  tables: {
    [LONG_BLOCKS_TABLE]: {
      primaryKey: "block_id",
      columns: {
        block_id: { type: "string" },
        user_id: { type: "string" },
        memory_space_id: { type: "string" },
        domain: { type: "string" },
        title: { type: "string" },
        title_key: { type: "string" },
        summary: { type: "string" },
        overview_body: { type: "string" },
        lifecycle_status: { type: "string" },
        value_version: { type: "string" },
        value_state: { type: "json" },
        created_at: { type: "datetime" },
        updated_at: { type: "datetime" },
        content_updated_at: { type: "datetime", backfill: "updated_at" },
      },
      indexes: [
        // Daily 阶段三按 Domain 召回候选块 + 按空间读块。
        {
          name: "long_blocks_space_domain_lifecycle",
          fields: ["memory_space_id", "domain", "lifecycle_status"],
        },
        // 弱/强检索 title 完全匹配。
        { name: "long_blocks_space_title_key", fields: ["memory_space_id", "title_key"] },
        // Daily 阶段七全量衰减：遍历空间内全部有效 Long。
        { name: "long_blocks_space_lifecycle", fields: ["memory_space_id", "lifecycle_status"] },
      ],
    },
    [LONG_DETAILS_TABLE]: {
      primaryKey: "detail_id",
      columns: {
        detail_id: { type: "string" },
        block_id: { type: "string" },
        user_id: { type: "string" },
        memory_space_id: { type: "string" },
        summary: { type: "string" },
        body: { type: "string" },
        lifecycle_status: { type: "string" },
        value_version: { type: "string" },
        value_state: { type: "json" },
        created_at: { type: "datetime" },
        updated_at: { type: "datetime" },
      },
      indexes: [
        // 读块时取全部细节（弱检索块内检索、Daily 读完整块、Weekly）。
        { name: "long_details_block_id", fields: ["block_id"] },
        // 按空间只读查看（面向用户）+ 归档清理。
        { name: "long_details_space_lifecycle", fields: ["memory_space_id", "lifecycle_status"] },
      ],
    },
    [LONG_ALIASES_TABLE]: {
      primaryKey: "alias_id",
      columns: {
        alias_id: { type: "string" },
        block_id: { type: "string" },
        user_id: { type: "string" },
        memory_space_id: { type: "string" },
        alias: { type: "string" },
        alias_key: { type: "string" },
      },
      indexes: [
        // 同一块内不重复别名。
        {
          name: "long_aliases_block_alias_key",
          fields: ["block_id", "alias_key"],
          unique: true,
        },
        // 在线检索 alias 完全匹配。
        { name: "long_aliases_space_alias_key", fields: ["memory_space_id", "alias_key"] },
      ],
    },
    [LONG_KEYWORDS_TABLE]: {
      primaryKey: "keyword_id",
      columns: {
        keyword_id: { type: "string" },
        block_id: { type: "string" },
        user_id: { type: "string" },
        memory_space_id: { type: "string" },
        keyword: { type: "string" },
        keyword_key: { type: "string" },
      },
      indexes: [
        {
          name: "long_keywords_block_keyword_key",
          fields: ["block_id", "keyword_key"],
          unique: true,
        },
        { name: "long_keywords_space_keyword_key", fields: ["memory_space_id", "keyword_key"] },
      ],
    },
  },
} as const satisfies RelationalSchemaDefinition

/**
 * 构造 Long 向量集合定义；`dimensions` 必须与所选 Embedding 模型输出维度一致，
 * 由宿主在装配时确定并合并到向量 adapter。
 *
 * 块 summary 与细节 summary 平级存放，用 `recordType` 区分；归档即删向量，
 * 关系表保留 archived 行供运维查看，因此向量库天然只含 active/observing。
 */
export function defineLongVectorSchema(dimensions: number): VectorSchemaDefinition {
  return {
    collections: {
      [LONG_VECTOR_COLLECTION]: {
        dimensions,
        metric: "cosine",
        filterFields: {
          userId: "string",
          memorySpaceId: "string",
          domain: "string",
          blockId: "string",
          recordType: "string",
        },
      },
    },
  }
}
