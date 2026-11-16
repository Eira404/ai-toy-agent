/**
 * `toy-memory-fast` 的公共类型契约。
 *
 * 跨包只通过这里导出的类型沟通：`FastRecord` 由本包拥有，
 * `toy-memory-write` / `toy-memory-read` / `toy-memory-daily` 只读不写。
 */

/** 范围隔离：宿主已校验的用户与记忆空间。 */
export interface Scope {
  readonly userId: string
  readonly memorySpaceId: string
}

/**
 * 记忆草稿：由 `toy-memory-write` 提取并校验后传入 `append`。
 *
 * 只包含正文三字段；`fastId`、`writeId`、来源、时间和 `titleKey`
 * 全部由 Fast 包程序生成，模型不负责也不允许伪造。
 */
export interface FastDraft {
  /** 记忆标题，具体、稳定、简短的对象或子主题名称。 */
  readonly title: string
  /** 语义检索摘要，包含核心对象、关键动作或关系及当前有效结论。 */
  readonly summary: string
  /** 完整自包含正文，Markdown 无序列表，可直接提供给回答 Agent。 */
  readonly body: string
}

/**
 * 落库后的 Fast 记录，与关系表 `toy_memory_fast_records` 的行一一对应（camelCase）。
 *
 * `titleKey` 由程序规范化（NFKC + 英文小写 + 首尾 trim），供标题完全匹配，
 * 上层只读不写、不做业务判断。`consumedBatchId` 非空表示已被 Daily 成功消费，
 * 不再参与正常检索。
 */
export interface FastRecord {
  readonly fastId: string
  readonly writeId: string
  readonly userId: string
  readonly memorySpaceId: string
  readonly sessionId: string
  readonly turnId: string
  /** 创建时间，ISO 8601 字符串；相似度相同时的稳定排序键。 */
  readonly createdAt: string
  readonly title: string
  readonly titleKey: string
  readonly summary: string
  readonly body: string
  readonly consumedBatchId: string | null
  readonly consumedAt: string | null
}

/**
 * 向量索引待办的状态机。
 *
 * `pending` →（认领）→ `processing` →（成功）→ `done`；
 * `processing` 失败后 `attempts + 1` 并退回 `pending`，按退避时间等待；
 * `attempts` 达到上限后进入 `failed` 终态。
 */
export type FastEmbeddingJobStatus = "pending" | "processing" | "done" | "failed"

/** 检索命中原因；同一记录被两路同时命中时两个原因都保留。 */
export type FastHitReason = "TITLE" | "VECTOR"

/** 单条检索命中：完整记录 + 命中原因 + 向量相似度。 */
export interface FastSearchHit {
  readonly record: FastRecord
  readonly matchedBy: readonly FastHitReason[]
  /**
   * 余弦相似度，范围约 [-1, 1]，越大越相关；仅 `VECTOR` 命中时非 null。
   * 内部由 pgvector 的 cosine distance 转换而来（`1 - distance`）。
   */
  readonly vectorScore: number | null
}

/**
 * `search` 的返回。`titleSucceeded` / `vectorSucceeded` 描述两条分支各自是否成功，
 * 由上层（`toy-memory-read`）据此与 Long 结果汇总成 `COMPLETE` / `PARTIAL` / `UNAVAILABLE`。
 */
export interface FastSearchResult {
  readonly titleSucceeded: boolean
  readonly vectorSucceeded: boolean
  /** 已排好序：标题完全匹配在前，其余按相似度降序、同分按创建时间倒序。 */
  readonly hits: readonly FastSearchHit[]
}

/** `append` 的输入：空间、来源 Session/Turn 与已校验的非空草稿。 */
export interface FastAppendInput {
  readonly scope: Scope
  readonly sessionId: string
  readonly turnId: string
  /** 非空；空提取由 `toy-memory-write` 自己结束任务，不会调用本方法。 */
  readonly drafts: readonly FastDraft[]
}

/** `append` 的结果：本次写入批次 ID 与已落库的完整记录。 */
export interface FastAppendResult {
  readonly writeId: string
  readonly records: readonly FastRecord[]
}

/** `search` 的输入；`queryVector` 由上层算好传入，为 null 时只走标题完全匹配。 */
export interface FastSearchInput {
  readonly scope: Scope
  /** 专用记忆检索 Query，用于 `title_key` 规范化后的完全匹配。 */
  readonly query: string
  readonly queryVector: readonly number[] | null
}

/** `runEmbeddingJobs` 的调用选项；省略 `scope` 表示处理所有记忆空间。 */
export interface RunEmbeddingJobsOptions {
  readonly scope?: Scope
  readonly signal?: AbortSignal
}

/** `runEmbeddingJobs` 的结果统计。 */
export interface RunEmbeddingJobsResult {
  /** 本轮条件更新抢到的 job 数。 */
  readonly claimed: number
  /** 成功生成并写入向量的 job 数。 */
  readonly completed: number
  /** 本轮失败（退回 pending 或进入 failed 终态）的 job 数。 */
  readonly failed: number
}

/** `prepareConsumption` 的输入：Daily 冻结的待处理 Fast。 */
export interface PrepareConsumptionInput {
  readonly scope: Scope
  /** 本次 Daily 批次 ID，将写入记录的 `consumed_batch_id`。 */
  readonly batchId: string
  readonly fastIds: readonly string[]
}

/**
 * `prepareConsumption` 生成的消费计划，由 Daily 在最终提交时执行。
 *
 * 由于 v4 的 relational 与 vector 是两个独立 adapter、无法跨源联合事务，
 * 执行拆成两段：
 *
 * - 阶段 A（relational 事务）：`records` 写 `consumed_batch_id/consumed_at`，
 *   `writeIdsToCancel` 置 `done`（防止消费后又被补写向量）；
 * - 阶段 B（事务提交后，幂等）：`vector.deleteMany(vectorIdsToDelete)`。
 *
 * 先标关系消费即可让记录立刻退出检索（回表校验 `consumed_batch_id IS NULL`），
 * 向量残留只浪费存储、不影响正确性。
 */
export interface FastConsumptionPlan {
  readonly batchId: string
  readonly records: readonly FastRecord[]
  readonly vectorIdsToDelete: readonly string[]
  readonly writeIdsToCancel: readonly string[]
}

/** 分页游标：按 `(created_at, fast_id)` 稳定定位，倒序浏览。 */
export interface FastCursor {
  readonly createdAt: string
  readonly fastId: string
}

/** 运维分页浏览一个记忆空间 Fast 记录的输入。 */
export interface ListFastInput {
  readonly scope: Scope
  /** 每页条数，默认 20，范围 1-100。 */
  readonly limit?: number
  /** 上一页游标，省略时从最新一条开始。 */
  readonly before?: FastCursor
  /** true 只返回未消费记录；省略返回全部（含已消费）。 */
  readonly pendingOnly?: boolean
}

/** 分页结果；`nextCursor` 为 undefined 表示没有下一页。 */
export interface FastPage {
  readonly items: readonly FastRecord[]
  readonly nextCursor: FastCursor | undefined
}

/** 一个记忆空间 Fast 记录的计数统计。 */
export interface FastCount {
  /** 全部记录数（含已消费）。 */
  readonly total: number
  /** 未消费记录数。 */
  readonly pending: number
  /** 已消费记录数，等于 `total - pending`。 */
  readonly consumed: number
}
