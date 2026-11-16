import { randomUUID } from "node:crypto"
import { Service, type Context } from "cordis"
import "toy-storage"
import "toy-embedding"
import type { RelationalAdapter, RelationalFilter, RelationalRecord } from "toy-storage-relational"
import type { VectorAdapter, VectorSearchOperation } from "toy-storage-vector"
import {
  computeBackoffDelay,
  resolveFastConfig,
  type FastConfig,
  type ResolvedFastConfig,
} from "./config.js"
import { FastMemoryError } from "./error.js"
import { recordFromRow, recordToRow } from "./relational.js"
import { FAST_JOBS_TABLE, FAST_RECORDS_TABLE, FAST_VECTOR_COLLECTION } from "./schema.js"
import { normalizeTitleKey } from "./title-key.js"
import type {
  FastAppendInput,
  FastAppendResult,
  FastConsumptionPlan,
  FastCount,
  FastDraft,
  FastPage,
  FastRecord,
  FastSearchHit,
  FastSearchInput,
  FastSearchResult,
  ListFastInput,
  PrepareConsumptionInput,
  RunEmbeddingJobsOptions,
  RunEmbeddingJobsResult,
  Scope,
} from "./types.js"

declare module "cordis" {
  interface Context {
    memoryFast: FastMemory
  }
}

/**
 * Fast 证据层的 Cordis 服务。
 *
 * 职责：追加记忆草稿、近期读取、向量索引补写、双通道检索，以及为 Daily
 * 提供待处理读取和消费计划。正文只追加不修改，向量命中后回关系表校验消费状态。
 *
 * 依赖：命名存储（`relational` + 可选 `vector` 实例）和 `toy-embedding`。
 * `append` 成功后会 fire-and-forget 触发一次 `runEmbeddingJobs`，宿主无需调度。
 */
export class FastMemory extends Service {
  static inject = ["storage", "embedding"]

  private readonly config: ResolvedFastConfig
  private relational: RelationalAdapter | undefined
  private vector: VectorAdapter | undefined

  /** @param config 装配配置；`embeddingProvider` 与 `embeddingModel` 必填。 */
  constructor(ctx: Context, config: FastConfig) {
    super(ctx, "memoryFast")
    this.config = resolveFastConfig(config)
  }

  /** 核对命名存储实例；relational 必需，vector 可选（缺失时检索降级为 title 路）。 */
  [Service.init](): void {
    const relational = this.ctx.storage.tryGet<RelationalAdapter>(
      "relational",
      this.config.relationalSource,
    )
    if (relational === undefined) {
      throw new FastMemoryError(
        "source-not-ready",
        `关系型存储实例 'relational/${this.config.relationalSource}' 尚未就绪`,
      )
    }
    this.relational = relational
    this.vector = this.ctx.storage.tryGet<VectorAdapter>("vector", this.config.vectorSource)
  }

  /**
   * 追加一批记忆草稿：程序分配 ID，同一关系事务写主记录与向量待办。
   *
   * 并发重试同一 Turn 时，唯一索引 `(memory_space_id, session_id, turn_id)`
   * 会拒绝重复的待办行，此时幂等返回已提交的那批记录。成功后会触发一次
   * 后台向量补写（不阻塞返回）。
   *
   * @param input 空间、来源 Session/Turn 与已校验的非空草稿。
   * @returns 本次写入批次 ID 与已落库记录。
   */
  async append(input: FastAppendInput): Promise<FastAppendResult> {
    assertScope(input.scope)
    assertNonEmpty(input.sessionId, "sessionId")
    assertNonEmpty(input.turnId, "turnId")
    if (input.drafts.length === 0) {
      throw new FastMemoryError("invalid-input", "drafts 不能为空：空提取不应调用 append")
    }

    const writeId = randomUUID()
    const createdAt = this.config.now()
    const records: FastRecord[] = input.drafts.map((draft) => this.buildRecord(input, writeId, createdAt, draft))
    const jobRow = this.buildJobRow(input, writeId, createdAt)

    try {
      await this.requireRelational().transaction(async (tx) => {
        await tx.execute({
          type: "insertMany",
          table: FAST_RECORDS_TABLE,
          values: records.map(recordToRow),
        })
        await tx.execute({ type: "insert", table: FAST_JOBS_TABLE, value: jobRow })
      })
    } catch (error) {
      const committed = await this.loadCommittedBatch(input.scope, input.sessionId, input.turnId)
      if (committed !== undefined) {
        return committed
      }
      throw error
    }

    if (this.config.autoIndex) {
      this.triggerEmbeddingJobs(input.scope)
    }
    return { writeId, records }
  }

  /**
   * 返回该 Session 最近的有效（未消费）Fast，按创建时间与 ID 稳定倒序。
   *
   * 供 `toy-memory-write` 提取消歧；不依赖向量是否已生成。
   *
   * @param scope 范围隔离。
   * @param sessionId 来源 Session。
   * @param limit 返回条数上限。
   */
  async listRecentBySession(scope: Scope, sessionId: string, limit: number): Promise<FastRecord[]> {
    assertScope(scope)
    assertNonEmpty(sessionId, "sessionId")
    assertPositiveInteger(limit, "limit")
    const result = await this.requireRelational().execute({
      type: "find",
      table: FAST_RECORDS_TABLE,
      where: and([eq("memory_space_id", scope.memorySpaceId), eq("session_id", sessionId), isNull("consumed_batch_id")]),
      orderBy: [
        { field: "created_at", direction: "desc" },
        { field: "fast_id", direction: "desc" },
      ],
      limit,
    })
    return result.rows.map(recordFromRow)
  }

  /**
   * 双通道检索：标题完全匹配 + summary 向量相似，按 `fast_id` 去重合并。
   *
   * 标题命中全部返回且排最前、不受数量限制；向量命中按相似度阈值过滤，
   * 不足最低数量时按相似度补足、超过最大数量时截取。`queryVector` 为 null
   * 或向量实例缺失时只走标题路，并通过 `vectorSucceeded` 告知上层降级。
   *
   * @param input 范围、专用检索 Query 与可选 Query 向量。
   */
  async search(input: FastSearchInput): Promise<FastSearchResult> {
    assertScope(input.scope)
    if (typeof input.query !== "string" || input.query.trim().length === 0) {
      throw new FastMemoryError("invalid-input", "query 必须是非空字符串")
    }

    const relational = this.requireRelational()
    const vector = this.vector
    const queryVector = input.queryVector

    // 标题完全匹配与向量相似两路并行，各自捕获失败、互不影响。
    // 向量路内部是“向量检索 → 回表”两个顺序步骤，与标题路的关系查询并发执行。
    const vectorPromise: Promise<{ succeeded: boolean; results: { record: FastRecord; score: number }[] }> =
      vector !== undefined && queryVector !== null
        ? this.searchByVector(relational, vector, input.scope, queryVector)
        : Promise.resolve({ succeeded: false, results: [] })

    const [titleBranch, vectorBranch] = await Promise.all([
      this.searchByTitle(relational, input.scope, normalizeTitleKey(input.query)),
      vectorPromise,
    ])

    return {
      titleSucceeded: titleBranch.succeeded,
      vectorSucceeded: vectorBranch.succeeded,
      hits: this.mergeHits(titleBranch.records, vectorBranch.results),
    }
  }

  /** 标题完全匹配分支：按规范化 `title_key` 精确相等查询有效记录。 */
  private async searchByTitle(
    relational: RelationalAdapter,
    scope: Scope,
    titleKey: string,
  ): Promise<{ succeeded: boolean; records: FastRecord[] }> {
    try {
      const result = await relational.execute({
        type: "find",
        table: FAST_RECORDS_TABLE,
        where: and([
          eq("memory_space_id", scope.memorySpaceId),
          isNull("consumed_batch_id"),
          eq("title_key", titleKey),
        ]),
        orderBy: [
          { field: "created_at", direction: "desc" },
          { field: "fast_id", direction: "desc" },
        ],
      })
      return { succeeded: true, records: result.rows.map(recordFromRow) }
    } catch {
      return { succeeded: false, records: [] }
    }
  }

  /** 向量相似分支：向量检索命中后回关系表校验消费状态，并把 distance 换算成相似度。 */
  private async searchByVector(
    relational: RelationalAdapter,
    vector: VectorAdapter,
    scope: Scope,
    queryVector: readonly number[],
  ): Promise<{ succeeded: boolean; results: { record: FastRecord; score: number }[] }> {
    try {
      const limit = Math.min(this.config.maxVectorCount * 3, 100)
      // 向量层的 where 只支持一层 eq 的 and（字段名 camelCase），与关系层不同。
      const searchOperation: VectorSearchOperation = {
        type: "search",
        collection: FAST_VECTOR_COLLECTION,
        vector: queryVector,
        where: {
          type: "and",
          conditions: [
            { type: "eq", field: "userId", value: scope.userId },
            { type: "eq", field: "memorySpaceId", value: scope.memorySpaceId },
          ],
        },
        limit,
      }
      const searchResult = await vector.execute(searchOperation)
      const scores = new Map(searchResult.matches.map((match) => [match.id, 1 - match.distance]))
      const fastIds = [...scores.keys()]
      if (fastIds.length === 0) {
        return { succeeded: true, results: [] }
      }
      const rows = await relational.execute({
        type: "find",
        table: FAST_RECORDS_TABLE,
        where: and([
          eq("memory_space_id", scope.memorySpaceId),
          isNull("consumed_batch_id"),
          { type: "in", field: "fast_id", values: fastIds },
        ]),
      })
      const results: { record: FastRecord; score: number }[] = []
      for (const row of rows.rows) {
        const fastId = String(row.fast_id)
        const score = scores.get(fastId)
        if (score !== undefined) {
          results.push({ record: recordFromRow(row), score })
        }
      }
      return { succeeded: true, results }
    } catch {
      return { succeeded: false, results: [] }
    }
  }

  /**
   * 认领一批待办并补写向量，由 `append` 后台触发，也可由宿主/运维手动调用。
   *
   * 认领用“条件更新 + 租约”保证并发安全：`affectedRows === 1` 才算抢到；
   * `processing` 且租约超时的任务视为崩溃遗留，可被重新认领。失败按指数退避
   * 重试，达到上限进入 `failed` 终态并记录 `last_error`。
   *
   * @param options 可选范围与取消信号。
   */
  async runEmbeddingJobs(options: RunEmbeddingJobsOptions = {}): Promise<RunEmbeddingJobsResult> {
    if (this.vector === undefined) {
      // 向量实例未就绪时直接空转，不认领也不产生失败，等宿主装配完成后补做。
      return { claimed: 0, completed: 0, failed: 0 }
    }
    if (options.scope !== undefined) {
      assertScope(options.scope)
    }

    const relational = this.requireRelational()
    const now = this.config.now()
    const scopeFilters: RelationalFilter[] =
      options.scope === undefined
        ? []
        : [eq("memory_space_id", options.scope.memorySpaceId), eq("user_id", options.scope.userId)]

    const pendingWhere = and([
      eq("status", "pending"),
      { type: "lte", field: "next_attempt_at", value: now },
      ...scopeFilters,
    ])
    const staleWhere = and([
      eq("status", "processing"),
      { type: "lte", field: "lease_until", value: now },
      ...scopeFilters,
    ])

    const [pending, stale] = await Promise.all([
      relational.execute({
        type: "find",
        table: FAST_JOBS_TABLE,
        where: pendingWhere,
        orderBy: [{ field: "next_attempt_at", direction: "asc" }],
        limit: this.config.batchSize,
      }),
      relational.execute({ type: "find", table: FAST_JOBS_TABLE, where: staleWhere, limit: this.config.batchSize }),
    ])

    const token = randomUUID()
    const until = new Date(Date.parse(now) + this.config.leaseMs).toISOString()
    const claimed: RelationalRecord[] = []
    for (const job of [...pending.rows, ...stale.rows]) {
      const writeId = String(job.write_id)
      const result = await relational.execute({
        type: "update",
        table: FAST_JOBS_TABLE,
        where: and([
          eq("write_id", writeId),
          or([
            and([eq("status", "pending"), { type: "lte", field: "next_attempt_at", value: now }]),
            and([eq("status", "processing"), { type: "lte", field: "lease_until", value: now }]),
          ]),
        ]),
        patch: { status: "processing", lease_token: token, lease_until: until, updated_at: now },
      })
      if (result.affectedRows === 1) {
        claimed.push(job)
      }
    }

    let completed = 0
    let failed = 0
    for (const job of claimed) {
      if (await this.processJob(job, token, now)) {
        completed += 1
      } else {
        failed += 1
      }
    }
    return { claimed: claimed.length, completed, failed }
  }

  /**
   * 返回该空间所有未消费 Fast，按创建时间升序。
   *
   * 供 Daily 阶段一使用。调用方（Daily）应在 Dream Gate 已 `LOCKED`、空间内
   * 不存在进行中 Session 时调用，此时返回的即本次可处理的全部待处理 Fast。
   *
   * @param scope 范围隔离。
   */
  async listPendingForDaily(scope: Scope): Promise<FastRecord[]> {
    assertScope(scope)
    const result = await this.requireRelational().execute({
      type: "find",
      table: FAST_RECORDS_TABLE,
      where: and([eq("memory_space_id", scope.memorySpaceId), isNull("consumed_batch_id")]),
      orderBy: [
        { field: "created_at", direction: "asc" },
        { field: "fast_id", direction: "asc" },
      ],
    })
    return result.rows.map(recordFromRow)
  }

  /**
   * 运维分页浏览一个记忆空间下的 Fast 记录，倒序（最新在前）。
   *
   * 默认返回全部（含已消费）；`pendingOnly: true` 只返回未消费。游标
   * `(createdAt, fastId)` 与排序键一致，保证翻页稳定、不重不漏。
   *
   * @param input 范围、页大小、可选游标与是否只看未消费。
   */
  async listBySpace(input: ListFastInput): Promise<FastPage> {
    assertScope(input.scope)
    const limit = this.resolvePageLimit(input.limit)
    if (input.before !== undefined) {
      assertTimestamp(input.before.createdAt, "before.createdAt")
      assertNonEmpty(input.before.fastId, "before.fastId")
    }

    const conditions: RelationalFilter[] = [eq("memory_space_id", input.scope.memorySpaceId)]
    if (input.pendingOnly === true) {
      conditions.push(isNull("consumed_batch_id"))
    }
    if (input.before !== undefined) {
      conditions.push(
        or([
          { type: "lt", field: "created_at", value: input.before.createdAt },
          and([
            eq("created_at", input.before.createdAt),
            { type: "lt", field: "fast_id", value: input.before.fastId },
          ]),
        ]),
      )
    }

    const result = await this.requireRelational().execute({
      type: "find",
      table: FAST_RECORDS_TABLE,
      where: and(conditions),
      orderBy: [
        { field: "created_at", direction: "desc" },
        { field: "fast_id", direction: "desc" },
      ],
      limit: limit + 1,
    })

    const items = result.rows.slice(0, limit).map(recordFromRow)
    const last = items.at(-1)
    return {
      items,
      nextCursor:
        result.rows.length > limit && last !== undefined
          ? { createdAt: last.createdAt, fastId: last.fastId }
          : undefined,
    }
  }

  /**
   * 统计一个记忆空间下的 Fast 记录数，一次返回总量、未消费与已消费。
   *
   * 供分页器显示总数、监控未消费积压量。已消费 = 总量 - 未消费。
   *
   * @param scope 范围隔离。
   */
  async countBySpace(scope: Scope): Promise<FastCount> {
    assertScope(scope)
    const [totalResult, pendingResult] = await Promise.all([
      this.requireRelational().execute({
        type: "count",
        table: FAST_RECORDS_TABLE,
        where: eq("memory_space_id", scope.memorySpaceId),
      }),
      this.requireRelational().execute({
        type: "count",
        table: FAST_RECORDS_TABLE,
        where: and([eq("memory_space_id", scope.memorySpaceId), isNull("consumed_batch_id")]),
      }),
    ])
    const total = totalResult.count
    const pending = pendingResult.count
    return { total, pending, consumed: total - pending }
  }

  /**
   * 按 fastId 读取单条 Fast 记录（运维查看用）。
   *
   * 不存在或不属于 `scope.memorySpaceId` 时返回 null；不返回其他空间的数据。
   *
   * @param scope 范围隔离。
   * @param fastId 目标记录主键。
   */
  async getFast(scope: Scope, fastId: string): Promise<FastRecord | null> {
    assertScope(scope)
    assertNonEmpty(fastId, "fastId")
    const result = await this.requireRelational().execute({
      type: "get",
      table: FAST_RECORDS_TABLE,
      key: fastId,
    })
    if (result.row === undefined) {
      return null
    }
    const record = recordFromRow(result.row)
    return record.memorySpaceId === scope.memorySpaceId ? record : null
  }

  /**
   * 为 Daily 生成本批次消费计划（不直接执行）。
   *
   * 校验 `fastIds` 都属于范围且未消费后，返回：待写消费标记的记录、待删除的
   * 向量 ID（即这些 `fastId`），以及需要置为 `done` 的未完成索引任务。
   * Daily 在最终提交时执行：关系消费进 relational 事务，向量删除在事务提交后幂等执行。
   *
   * @param input 范围、批次 ID 与待消费 Fast ID。
   */
  async prepareConsumption(input: PrepareConsumptionInput): Promise<FastConsumptionPlan> {
    assertScope(input.scope)
    assertNonEmpty(input.batchId, "batchId")
    if (input.fastIds.length === 0) {
      throw new FastMemoryError("invalid-input", "fastIds 不能为空")
    }
    const uniqueIds = [...new Set(input.fastIds)]
    if (uniqueIds.length !== input.fastIds.length) {
      throw new FastMemoryError("invalid-input", "fastIds 不能重复")
    }

    const result = await this.requireRelational().execute({
      type: "find",
      table: FAST_RECORDS_TABLE,
      where: and([
        eq("memory_space_id", input.scope.memorySpaceId),
        isNull("consumed_batch_id"),
        { type: "in", field: "fast_id", values: uniqueIds },
      ]),
    })
    const records = result.rows.map(recordFromRow)
    if (records.length !== uniqueIds.length) {
      throw new FastMemoryError("consume-mismatch", "部分 fastId 不存在、不属于该空间或已被消费")
    }

    const writeIds = [...new Set(records.map((record) => record.writeId))]
    const jobResult =
      writeIds.length === 0
        ? { rows: [] }
        : await this.requireRelational().execute({
            type: "find",
            table: FAST_JOBS_TABLE,
            where: and([
              { type: "in", field: "write_id", values: writeIds },
              { type: "ne", field: "status", value: "done" },
            ]),
          })

    return {
      batchId: input.batchId,
      records,
      vectorIdsToDelete: records.map((record) => record.fastId),
      writeIdsToCancel: jobResult.rows.map((row) => String(row.write_id)),
    }
  }

  /**
   * 执行消费计划（由 Daily 在阶段八最终提交时调用）。
   *
   * 幂等：关系表用 `consumed_batch_id IS NULL` / `status != done` 条件更新，
   * 已消费的记录和已结束的任务不会被重复修改；向量删除天然幂等（删已不存在的
   * ID 返回 0 行、不报错）。关系事务提交后，向量删除独立执行——向量残留只
   * 浪费存储、不影响正确性（检索回表会校验 `consumed_batch_id IS NULL`）。
   *
   * @param plan prepareConsumption 返回的消费计划。
   */
  async applyConsumption(plan: FastConsumptionPlan): Promise<void> {
    if (plan.records.length === 0) {
      return
    }
    const now = this.config.now()
    const relational = this.requireRelational()
    const fastIds = plan.records.map((record) => record.fastId)

    // 阶段 A：关系事务内写消费标记 + 取消未完成的索引任务。
    await relational.transaction(async (tx) => {
      await tx.execute({
        type: "update",
        table: FAST_RECORDS_TABLE,
        where: and([
          { type: "in", field: "fast_id", values: fastIds },
          isNull("consumed_batch_id"),
        ]),
        patch: {
          consumed_batch_id: plan.batchId,
          consumed_at: now,
        },
      })
      if (plan.writeIdsToCancel.length > 0) {
        await tx.execute({
          type: "update",
          table: FAST_JOBS_TABLE,
          where: and([
            { type: "in", field: "write_id", values: plan.writeIdsToCancel },
            { type: "ne", field: "status", value: "done" },
          ]),
          patch: {
            status: "done",
            updated_at: now,
          },
        })
      }
    })

    // 阶段 B：事务提交后幂等删除向量。
    if (this.vector !== undefined && plan.vectorIdsToDelete.length > 0) {
      await this.vector.execute({
        type: "deleteMany",
        collection: FAST_VECTOR_COLLECTION,
        ids: plan.vectorIdsToDelete,
      })
    }
  }

  /** 由草稿 + 程序字段构造一条完整 `FastRecord`。 */
  private buildRecord(input: FastAppendInput, writeId: string, createdAt: string, draft: FastDraft): FastRecord {
    this.assertDraft(draft)
    return {
      fastId: randomUUID(),
      writeId,
      userId: input.scope.userId,
      memorySpaceId: input.scope.memorySpaceId,
      sessionId: input.sessionId,
      turnId: input.turnId,
      createdAt,
      title: draft.title,
      titleKey: normalizeTitleKey(draft.title),
      summary: draft.summary,
      body: draft.body,
      consumedBatchId: null,
      consumedAt: null,
    }
  }

  /** 构造一条 `pending` 状态的向量待办行。 */
  private buildJobRow(input: FastAppendInput, writeId: string, createdAt: string): RelationalRecord {
    return {
      write_id: writeId,
      user_id: input.scope.userId,
      memory_space_id: input.scope.memorySpaceId,
      session_id: input.sessionId,
      turn_id: input.turnId,
      status: "pending",
      attempts: 0,
      next_attempt_at: createdAt,
      lease_token: null,
      lease_until: null,
      last_error: null,
      created_at: createdAt,
      updated_at: createdAt,
    }
  }

  /** 幂等回读：按 (space, session, turn) 找已提交批次，找不到返回 undefined。 */
  private async loadCommittedBatch(
    scope: Scope,
    sessionId: string,
    turnId: string,
  ): Promise<FastAppendResult | undefined> {
    const jobResult = await this.requireRelational().execute({
      type: "find",
      table: FAST_JOBS_TABLE,
      where: and([
        eq("memory_space_id", scope.memorySpaceId),
        eq("session_id", sessionId),
        eq("turn_id", turnId),
      ]),
      limit: 1,
    })
    const job = jobResult.rows[0]
    if (job === undefined) {
      return undefined
    }
    const writeId = String(job.write_id)
    const records = await this.loadRecordsByWriteId(writeId)
    return { writeId, records }
  }

  /** 按 `write_id` 回读同批记录（供索引补写与幂等返回）。 */
  private async loadRecordsByWriteId(writeId: string): Promise<FastRecord[]> {
    const result = await this.requireRelational().execute({
      type: "find",
      table: FAST_RECORDS_TABLE,
      where: eq("write_id", writeId),
      orderBy: [
        { field: "created_at", direction: "asc" },
        { field: "fast_id", direction: "asc" },
      ],
    })
    return result.rows.map(recordFromRow)
  }

  /** 处理单个已认领的待办：回读有效记录 → 批量 Embedding → 写入向量 → 置 done。 */
  private async processJob(job: RelationalRecord, _token: string, now: string): Promise<boolean> {
    const writeId = String(job.write_id)
    const attempts = Number(job.attempts) + 1
    try {
      const valid = (await this.loadRecordsByWriteId(writeId)).filter(
        (record) => record.consumedBatchId === null,
      )
      if (valid.length === 0) {
        // 记录已全部消费，无需向量，直接结束本轮任务。
        await this.markJobDone(writeId, now)
        return true
      }

      const embedding = this.ctx.embedding
      const vector = this.vector
      if (vector === undefined) {
        throw new FastMemoryError("source-not-ready", "向量存储尚未就绪")
      }

      const result = await embedding.embed({
        provider: this.config.embeddingProvider,
        model: this.config.embeddingModel,
        texts: valid.map((record) => record.summary),
        operation: "memory-fast-index",
      })

      const collection = vector.schema.collections[FAST_VECTOR_COLLECTION]
      if (collection !== undefined && collection.dimensions !== result.dimensions) {
        throw new FastMemoryError(
          "dimension-mismatch",
          `Embedding 维度 ${result.dimensions} 与集合声明 ${collection.dimensions} 不一致`,
        )
      }

      await vector.execute({
        type: "upsertMany",
        collection: FAST_VECTOR_COLLECTION,
        values: valid.map((record, index) => ({
          id: record.fastId,
          vector: result.vectors[index] ?? [],
          fields: { userId: record.userId, memorySpaceId: record.memorySpaceId },
          payload: {},
        })),
      })

      await this.markJobDone(writeId, now)
      return true
    } catch (error) {
      return this.handleJobFailure(writeId, attempts, error, now)
    }
  }

  /** 失败处理：未达上限时指数退避退回 pending，达上限时进入 failed 终态。 */
  private async handleJobFailure(
    writeId: string,
    attempts: number,
    error: unknown,
    now: string,
  ): Promise<boolean> {
    const lastError = String(error instanceof Error ? error.message : error).slice(0, 2000)
    if (attempts >= this.config.maxAttempts) {
      await this.requireRelational().execute({
        type: "update",
        table: FAST_JOBS_TABLE,
        where: eq("write_id", writeId),
        patch: {
          status: "failed",
          attempts,
          lease_token: null,
          lease_until: null,
          last_error: lastError,
          updated_at: now,
        },
      })
    } else {
      const delay = computeBackoffDelay(attempts, this.config.backoffBaseMs, this.config.backoffJitter)
      const next = new Date(Date.parse(now) + delay).toISOString()
      await this.requireRelational().execute({
        type: "update",
        table: FAST_JOBS_TABLE,
        where: eq("write_id", writeId),
        patch: {
          status: "pending",
          attempts,
          next_attempt_at: next,
          lease_token: null,
          lease_until: null,
          last_error: lastError,
          updated_at: now,
        },
      })
    }
    return false
  }

  /** 待办成功结束。 */
  private async markJobDone(writeId: string, now: string): Promise<void> {
    await this.requireRelational().execute({
      type: "update",
      table: FAST_JOBS_TABLE,
      where: eq("write_id", writeId),
      patch: { status: "done", lease_token: null, lease_until: null, updated_at: now },
    })
  }

  /**
   * 合并两路命中：标题命中排最前、不受数量限制；向量命中先按阈值过滤，
   * 不足补足、超限截取。同一记录被两路命中时合并命中原因并保留向量分数。
   */
  private mergeHits(
    titleRecords: FastRecord[],
    vectorResults: { record: FastRecord; score: number }[],
  ): FastSearchHit[] {
    const titleIds = new Set(titleRecords.map((record) => record.fastId))

    const sorted = [...vectorResults].sort((left, right) => {
      const byScore = right.score - left.score
      if (byScore !== 0) {
        return byScore
      }
      if (left.record.createdAt !== right.record.createdAt) {
        return left.record.createdAt < right.record.createdAt ? 1 : -1
      }
      return left.record.fastId < right.record.fastId ? 1 : -1
    })

    const qualified = sorted.filter((item) => item.score >= this.config.minVectorScore)
    const belowThreshold = sorted.filter((item) => item.score < this.config.minVectorScore)

    // 已被标题命中的记录：记录其向量分数，命中原因合并到对应标题命中上。
    const titleVectorScore = new Map<string, number>()
    for (const item of qualified) {
      if (titleIds.has(item.record.fastId)) {
        titleVectorScore.set(item.record.fastId, item.score)
      }
    }

    // 纯向量命中：未被标题命中，先阈值过滤，不足补足，超限截取。
    let selected = qualified.filter((item) => !titleIds.has(item.record.fastId))
    if (selected.length < this.config.minVectorCount) {
      const need = this.config.minVectorCount - selected.length
      const fill = belowThreshold.filter((item) => !titleIds.has(item.record.fastId)).slice(0, need)
      selected = [...selected, ...fill]
    }
    selected = selected.slice(0, this.config.maxVectorCount)

    const hits: FastSearchHit[] = titleRecords.map((record) => {
      const score = titleVectorScore.get(record.fastId) ?? null
      return {
        record,
        matchedBy: score === null ? (["TITLE"] as const) : (["TITLE", "VECTOR"] as const),
        vectorScore: score,
      }
    })
    for (const item of selected) {
      hits.push({ record: item.record, matchedBy: ["VECTOR"] as const, vectorScore: item.score })
    }
    return hits
  }

  /** fire-and-forget 触发一次向量补写；失败静默，后续触发会扫到积压待办补做。 */
  private triggerEmbeddingJobs(scope: Scope): void {
    void this.runEmbeddingJobs({ scope }).catch((error: unknown) => {
      console.warn("[toy-memory-fast] 后台向量补写触发失败，等待后续触发重试", error)
    })
  }

  /** 校验草稿字段非空且不超过配置的硬限制。 */
  private assertDraft(draft: FastDraft): void {
    assertNonEmpty(draft.title, "draft.title")
    assertNonEmpty(draft.summary, "draft.summary")
    assertNonEmpty(draft.body, "draft.body")
    if (charCount(draft.title) > this.config.maxTitleLength) {
      throw new FastMemoryError("invalid-input", `draft.title 超过 ${this.config.maxTitleLength} 字符`)
    }
    if (charCount(draft.summary) > this.config.maxSummaryLength) {
      throw new FastMemoryError("invalid-input", `draft.summary 超过 ${this.config.maxSummaryLength} 字符`)
    }
    if (charCount(draft.body) > this.config.maxBodyLength) {
      throw new FastMemoryError("invalid-input", `draft.body 超过 ${this.config.maxBodyLength} 字符`)
    }
  }

  private requireRelational(): RelationalAdapter {
    if (this.relational === undefined) {
      throw new FastMemoryError("source-not-ready", "关系型存储实例尚未初始化")
    }
    return this.relational
  }

  /** 解析分页页大小：默认 20，范围 1-100。 */
  private resolvePageLimit(limit: number | undefined): number {
    const value = limit ?? 20
    if (!Number.isSafeInteger(value) || value < 1 || value > 100) {
      throw new FastMemoryError("invalid-input", "limit 必须是 1 到 100 的整数")
    }
    return value
  }
}

export default FastMemory

// ---------------------------------------------------------------------------
// 关系型条件树构造器与输入校验（模块级纯函数，不对外导出）
// ---------------------------------------------------------------------------

function eq(field: string, value: string): RelationalFilter {
  return { type: "eq", field, value }
}

function isNull(field: string): RelationalFilter {
  return { type: "isNull", field }
}

function and(conditions: readonly RelationalFilter[]): RelationalFilter {
  return { type: "and", conditions: [...conditions] }
}

function or(conditions: readonly RelationalFilter[]): RelationalFilter {
  return { type: "or", conditions: [...conditions] }
}

function assertScope(scope: Scope): void {
  assertNonEmpty(scope.userId, "scope.userId")
  assertNonEmpty(scope.memorySpaceId, "scope.memorySpaceId")
}

function assertNonEmpty(value: string, name: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new FastMemoryError("invalid-input", `${name} 必须是非空字符串`)
  }
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new FastMemoryError("invalid-input", `${name} 必须是正安全整数`)
  }
}

function assertTimestamp(value: string, name: string): void {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new FastMemoryError("invalid-input", `${name} 必须是有效的时间字符串`)
  }
}

/** 按 Unicode 码点计数，而非 UTF-16 码元，与 v2 的字符计数口径一致。 */
function charCount(value: string): number {
  return [...value].length
}
