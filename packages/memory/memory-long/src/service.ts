import { randomUUID } from "node:crypto"
import { Service, type Context } from "cordis"
import "toy-storage"
import type {
  RelationalAdapter,
  RelationalExecutor,
  RelationalFilter,
} from "toy-storage-relational"
import type {
  VectorAdapter,
  VectorEqualFilter,
  VectorFilter,
  VectorMatch,
  VectorRecord,
} from "toy-storage-vector"
import { resolveLongConfig, type LongConfig, type ResolvedLongConfig } from "./config.js"
import { LongMemoryError } from "./error.js"
import { normalizeKey, vectorRecordId } from "./normalize.js"
import {
  LONG_ALIASES_TABLE,
  LONG_BLOCKS_TABLE,
  LONG_DETAILS_TABLE,
  LONG_VECTOR_COLLECTION,
} from "./schema.js"
import {
  aliasRow,
  andWhere,
  assertLongSchema,
  blockFromRow,
  blockRow,
  detailFromRow,
  detailRow,
  eq,
  inSet,
  scopeWhere,
  type BlockRow,
} from "./relational.js"
import type {
  LifecycleStatus,
  ListLongInput,
  LongApplyResult,
  LongBlock,
  LongBlockContent,
  LongBlockHit,
  LongBlockPage,
  LongBlockSummary,
  LongChangeSet,
  LongDetailChange,
  LongDetailHit,
  LongDomain,
  LongSearchInput,
  LongSearchResult,
  ValueState,
  Scope,
} from "./types.js"

declare module "cordis" {
  interface Context {
    memoryLong: LongMemory
  }
}

/** 参与在线检索的生命周期状态；archived 不进检索。 */
const SEARCHABLE_LIFECYCLE: readonly LifecycleStatus[] = ["active", "observing"]
const BLOCK_ID_PREFIX = "block:"
const DETAIL_ID_PREFIX = "detail:"

/**
 * Long 长期记忆的 Cordis 服务。
 *
 * 职责：记忆块与细节的读写、弱/强检索、只读查询，以及为 Daily/Weekly 提供
 * 快照冻结与显式 CREATE/UPDATE/ARCHIVE 变更的原子应用。向量不在此生成：
 * 检索 Query 向量与写入用 summary Embedding 都由调用方准备好后传入。
 *
 * 依赖：命名存储（`relational` 必需 + 可选 `vector` 实例）。vector 缺失时
 * 检索降级为 title/alias 路，`applyChanges` 跳过向量索引维护。
 */
export class LongMemory extends Service {
  static inject = ["storage"]

  private readonly config: ResolvedLongConfig
  private readonly applied = new Map<string, LongApplyResult>()
  private relational: RelationalAdapter | undefined
  private vector: VectorAdapter | undefined

  /** @param config 装配配置；`relationalSource` / `vectorSource` 默认 `main`。 */
  constructor(ctx: Context, config: LongConfig = {}) {
    super(ctx, "memoryLong")
    this.config = resolveLongConfig(config)
  }

  /** 核对命名存储实例；relational 必需，vector 可选（缺失时检索降级）。 */
  [Service.init](): void {
    const relational = this.ctx.storage.tryGet<RelationalAdapter>(
      "relational",
      this.config.relationalSource,
    )
    if (relational === undefined) {
      throw new LongMemoryError(
        "source-not-ready",
        `关系型存储实例 'relational/${this.config.relationalSource}' 尚未就绪`,
      )
    }
    const vector = this.ctx.storage.tryGet<VectorAdapter>("vector", this.config.vectorSource)
    this.relational = relational
    this.vector = vector
    if (vector !== undefined) {
      assertLongSchema(relational, vector)
    }
  }

  // ────────────────────────────────────────────────────────────────
  // 在线检索
  // ────────────────────────────────────────────────────────────────

  /**
   * 弱检索（默认模式）：先命中相关记忆块，再在每个命中块内检索细节。
   *
   * 流程：title/alias 完全匹配 + 块 summary 向量两路并行选出块，按 blockId
   * 去重后，在每个命中块内做细节 summary 向量检索。title/alias 完全匹配的块
   * 排在纯向量命中块之前；块内细节按相似度降序。
   */
  async searchWeak(input: LongSearchInput): Promise<LongSearchResult> {
    assertScope(input.scope)
    assertQuery(input.query)
    const queryKey = normalizeKey(input.query)
    const flags = { title: true, blockVector: true, detailVector: true }

    // 第一层：title/alias 完全匹配与块 summary 向量召回并行。
    const titleBlocks = new Map<string, LongBlockSummary>()
    const vectorBlocks = new Map<string, number>()
    const vectorTask =
      input.queryVector !== null && this.vector !== undefined
        ? this.collectBlockVector(input.scope, input.queryVector, vectorBlocks).catch(() => {
            flags.blockVector = false
          })
        : Promise.resolve()
    await Promise.all([
      this.collectTitleMatches(input.scope, queryKey, titleBlocks).catch(() => {
        flags.title = false
      }),
      vectorTask,
    ])

    const orderedBlockIds = [...titleBlocks.keys(), ...vectorBlocks.keys()]
      .filter((id, index, list) => list.indexOf(id) === index)

    // 第二层：每个命中块并行做细节检索。
    const hitResults = await Promise.all(
      orderedBlockIds.map(async (blockId): Promise<LongBlockHit | null> => {
        const block = await this.loadBlock(input.scope, blockId)
        if (block === null || block.lifecycleStatus === "archived") {
          return null
        }
        let detailHits: LongDetailHit[] = []
        if (input.queryVector !== null && this.vector !== undefined) {
          try {
            detailHits = await this.collectDetailVector(input.scope, block, input.queryVector)
          } catch {
            // 单块细节检索失败不阻断其他块：该块仍返回完整块信息，但不返回细节。
            flags.detailVector = false
          }
        }
        return {
          blockId: block.blockId,
          domain: block.domain,
          title: block.title,
          aliases: block.aliases,
          summary: block.summary,
          overviewBody: block.overviewBody,
          reason: titleBlocks.has(blockId) ? "TITLE_MATCH" : "BLOCK_VECTOR",
          score: titleBlocks.has(blockId) ? null : (vectorBlocks.get(blockId) ?? null),
          details: detailHits,
        }
      }),
    )
    const hits = hitResults.filter((hit): hit is LongBlockHit => hit !== null)
    return { status: this.searchStatus(hits, input.queryVector, this.vector, flags), blocks: hits }
  }

  /**
   * 强检索：块 summary 与全部细节 summary 平级参与同一轮向量检索。
   *
   * title/alias 完全匹配的块直接进入结果；向量命中项按 blockId 组装：
   * 命中块 summary 时块 reason 为 BLOCK_VECTOR，只有细节命中时块 reason
   * 为 PARENT_CONTEXT，并随附完整块概括。blockScore 取该块直接命中项的最高分。
   */
  async searchStrong(input: LongSearchInput): Promise<LongSearchResult> {
    assertScope(input.scope)
    assertQuery(input.query)
    const queryKey = normalizeKey(input.query)
    const flags = { title: true, vector: true }

    const titleBlocks = new Map<string, LongBlockSummary>()
    const matches: {
      kind: "block" | "detail"
      blockId: string
      detailId: string | null
      score: number
    }[] = []

    // 第一层：title/alias 完全匹配与平级向量检索并行。
    const vectorTask =
      input.queryVector !== null && this.vector !== undefined
        ? this.collectStrongVector(input.scope, input.queryVector, matches).catch(() => {
            flags.vector = false
          })
        : Promise.resolve()
    await Promise.all([
      this.collectTitleMatches(input.scope, queryKey, titleBlocks).catch(() => {
        flags.title = false
      }),
      vectorTask,
    ])

    const byBlock = new Map<
      string,
      { blockMatched: boolean; score: number; details: { detailId: string; score: number }[] }
    >()
    for (const match of matches) {
      const group = byBlock.get(match.blockId) ?? {
        blockMatched: false,
        score: Number.NEGATIVE_INFINITY,
        details: [],
      }
      group.score = Math.max(group.score, match.score)
      if (match.kind === "block") {
        group.blockMatched = true
      } else if (match.detailId !== null) {
        group.details.push({ detailId: match.detailId, score: match.score })
      }
      byBlock.set(match.blockId, group)
    }

    const orderedBlockIds = [...titleBlocks.keys(), ...byBlock.keys()]
      .filter((id, index, list) => list.indexOf(id) === index)

    // 第二层：每个命中块并行读块与补全细节。
    const hitResults = await Promise.all(
      orderedBlockIds.map(async (blockId): Promise<LongBlockHit | null> => {
        const block = await this.loadBlock(input.scope, blockId)
        if (block === null || block.lifecycleStatus === "archived") {
          return null
        }
        const group = byBlock.get(blockId)
        const details = await this.materializeDetailHits(input.scope, block, group?.details ?? [])
        return {
          blockId: block.blockId,
          domain: block.domain,
          title: block.title,
          aliases: block.aliases,
          summary: block.summary,
          overviewBody: block.overviewBody,
          reason: titleBlocks.has(blockId)
            ? "TITLE_MATCH"
            : (group?.blockMatched ?? false)
              ? "BLOCK_VECTOR"
              : "PARENT_CONTEXT",
          score: titleBlocks.has(blockId) ? null : (group?.score ?? null),
          details,
        }
      }),
    )
    const hits = hitResults.filter((hit): hit is LongBlockHit => hit !== null)

    const titleHits = hits.filter((hit) => hit.reason === "TITLE_MATCH")
    const vectorHits = hits
      .filter((hit) => hit.reason !== "TITLE_MATCH")
      .sort((a, b) => (b.score ?? -1) - (a.score ?? -1) || (a.blockId < b.blockId ? -1 : 1))
    const blocks = [...titleHits, ...vectorHits]
    return { status: this.searchStatus(blocks, input.queryVector, this.vector, flags), blocks }
  }

  // ────────────────────────────────────────────────────────────────
  // 只读查询
  // ────────────────────────────────────────────────────────────────

  /**
   * 运维分页浏览一个记忆空间下的 Long 块，倒序（默认按更新时间，最新在前）。
   *
   * 默认返回全部（含 archived）；`domain` / `lifecycle` 可选过滤。游标
   * `(sortAt, blockId)` 与排序键一致，保证翻页稳定、不重不漏。
   *
   * @param input 范围、页大小、可选游标、过滤与排序字段。
   */
  async listBySpace(input: ListLongInput): Promise<LongBlockPage> {
    assertScope(input.scope)
    const limit = pageLimit(input.limit)
    const orderField = input.orderBy === "createdAt" ? "created_at" : "updated_at"
    if (input.domain !== undefined) {
      assertDomain(input.domain)
    }
    if (input.lifecycle !== undefined) {
      assertLifecycle(input.lifecycle)
    }
    if (input.before !== undefined) {
      assertTimestamp(input.before.sortAt)
      assertNonEmpty(input.before.blockId, "before.blockId")
    }

    const conditions: RelationalFilter[] = [scopeWhere(input.scope)]
    if (input.domain !== undefined) {
      conditions.push(eq("domain", input.domain))
    }
    if (input.lifecycle !== undefined) {
      conditions.push(eq("lifecycle_status", input.lifecycle))
    }
    if (input.before !== undefined) {
      conditions.push({
        type: "or",
        conditions: [
          { type: "lt", field: orderField, value: input.before.sortAt },
          {
            type: "and",
            conditions: [
              eq(orderField, input.before.sortAt),
              { type: "lt", field: "block_id", value: input.before.blockId },
            ],
          },
        ],
      })
    }

    const result = await this.requireRelational().execute({
      type: "find",
      table: LONG_BLOCKS_TABLE,
      where: andWhere(conditions),
      orderBy: [
        { field: orderField, direction: "desc" },
        { field: "block_id", direction: "desc" },
      ],
      limit: limit + 1,
    })
    const visible = result.rows.slice(0, limit)
    const items = await Promise.all(visible.map((row) => this.summarize(blockFromRow(row))))
    const lastRow = visible.at(-1)
    const last = lastRow === undefined ? undefined : blockFromRow(lastRow)
    return {
      items,
      nextCursor:
        result.rows.length > limit && last !== undefined
          ? {
              sortAt: orderField === "created_at" ? last.createdAt : last.updatedAt,
              blockId: last.blockId,
            }
          : undefined,
    }
  }

  /** 统计一个空间下的块数量，可选按 domain / lifecycle 过滤（默认含归档）。 */
  async countBlocks(
    scope: Scope,
    options: { domain?: LongDomain; lifecycle?: LifecycleStatus } = {},
  ): Promise<number> {
    assertScope(scope)
    if (options.domain !== undefined) {
      assertDomain(options.domain)
    }
    if (options.lifecycle !== undefined) {
      assertLifecycle(options.lifecycle)
    }
    const conditions: RelationalFilter[] = [scopeWhere(scope)]
    if (options.domain !== undefined) {
      conditions.push(eq("domain", options.domain))
    }
    if (options.lifecycle !== undefined) {
      conditions.push(eq("lifecycle_status", options.lifecycle))
    }
    const result = await this.requireRelational().execute({
      type: "count",
      table: LONG_BLOCKS_TABLE,
      where: andWhere(conditions),
    })
    return result.count
  }

  /** 按 Domain 分组统计块数量，返回六个 Domain 的完整计数（含 0）。 */
  async countBlocksByDomain(
    scope: Scope,
    options: { lifecycle?: LifecycleStatus } = {},
  ): Promise<Record<LongDomain, number>> {
    assertScope(scope)
    if (options.lifecycle !== undefined) {
      assertLifecycle(options.lifecycle)
    }
    const domains: readonly LongDomain[] = ["self", "person", "project", "topic", "entity", "event"]
    const entries = await Promise.all(
      domains.map(async (domain) => {
        const conditions: RelationalFilter[] = [scopeWhere(scope), eq("domain", domain)]
        if (options.lifecycle !== undefined) {
          conditions.push(eq("lifecycle_status", options.lifecycle))
        }
        const result = await this.requireRelational().execute({
          type: "count",
          table: LONG_BLOCKS_TABLE,
          where: andWhere(conditions),
        })
        return [domain, result.count] as const
      }),
    )
    return Object.fromEntries(entries) as Record<LongDomain, number>
  }

  /**
   * 读取完整块（含别名与全部细节，包括已归档细节），不存在或不属于 scope 时返回 null。
   */
  async getBlock(scope: Scope, blockId: string): Promise<LongBlock | null> {
    assertScope(scope)
    assertNonEmpty(blockId, "blockId")
    return this.loadBlock(scope, blockId)
  }

  // ────────────────────────────────────────────────────────────────
  // Daily 入口
  // ────────────────────────────────────────────────────────────────

  /** 读取某个 Domain 的全部有效（active/observing）块摘要，供阶段三召回与筛选。 */
  async listBlocksByDomain(scope: Scope, domain: LongDomain): Promise<LongBlockSummary[]> {
    assertScope(scope)
    assertDomain(domain)
    const result = await this.requireRelational().execute({
      type: "find",
      table: LONG_BLOCKS_TABLE,
      where: andWhere([
        scopeWhere(scope),
        eq("domain", domain),
        inSet("lifecycle_status", [...SEARCHABLE_LIFECYCLE]),
      ]),
      orderBy: [{ field: "block_id", direction: "asc" }],
    })
    return Promise.all(result.rows.map((row) => this.summarize(blockFromRow(row))))
  }

  /** 用候选 summary 向量在指定 Domain 召回块。 */
  async recallBySummary(
    scope: Scope,
    domain: LongDomain,
    vector: readonly number[],
    topK: number,
  ): Promise<{ blockId: string; score: number }[]> {
    assertScope(scope)
    assertDomain(domain)
    const limit = positiveInteger(topK, "topK", 100)
    const adapter = this.requireVector()
    const { matches } = await adapter.execute({
      type: "search",
      collection: LONG_VECTOR_COLLECTION,
      vector,
      where: vectorAnd([
        vectorEq("userId", scope.userId),
        vectorEq("memorySpaceId", scope.memorySpaceId),
        vectorEq("domain", domain),
        vectorEq("recordType", "block"),
      ]),
      limit,
    })
    return matches
      .map((match) => ({ blockId: match.id.slice(BLOCK_ID_PREFIX.length), score: 1 - match.distance }))
      .sort((a, b) => b.score - a.score)
  }

  /** 冻结当前全部有效 Long（active + observing，含细节与价值状态），供 Daily 阶段六/七。 */
  async freezeSnapshot(scope: Scope): Promise<LongBlock[]> {
    assertScope(scope)
    const result = await this.requireRelational().execute({
      type: "find",
      table: LONG_BLOCKS_TABLE,
      where: andWhere([scopeWhere(scope), inSet("lifecycle_status", [...SEARCHABLE_LIFECYCLE])]),
      orderBy: [{ field: "block_id", direction: "asc" }],
    })
    const blocks = await Promise.all(
      result.rows.map((row) => this.loadBlock(scope, blockFromRow(row).blockId)),
    )
    return blocks.filter((block): block is LongBlock => block !== null)
  }

  // ────────────────────────────────────────────────────────────────
  // Daily / Weekly 变更应用
  // ────────────────────────────────────────────────────────────────

  /**
   * 原子应用一组已校验的 Long 变更，并同步维护向量索引。
   *
   * 关系表变更（块/细节/别名）在关系事务内提交；随后向量 upsert/delete 独立提交。
   * 跨两者的最终原子性由 Daily 层（阶段八）通过幂等键与整体重试保证。
   *
   * @param scope 隔离范围。
   * @param changeSet 显式 CREATE/UPDATE/ARCHIVE 变更。
   * @param options.idempotencyKey 进程内幂等键，重复提交返回原结果。
   */
  async applyChanges(
    scope: Scope,
    changeSet: LongChangeSet,
    options: { idempotencyKey?: string } = {},
  ): Promise<LongApplyResult> {
    assertScope(scope)
    if (options.idempotencyKey !== undefined) {
      const cached = this.applied.get(options.idempotencyKey)
      if (cached !== undefined) {
        return cached
      }
    }
    this.assertChangeSet(changeSet)

    const now = this.config.now()
    const blockIds: string[] = []
    const archivedBlockIds: string[] = []
    const vectorUpserts: VectorRecord[] = []
    const vectorDeletes: string[] = []

    await this.requireRelational().transaction(async (tx) => {
      for (const change of changeSet.changes) {
        if (change.kind === "CREATE") {
          const blockId = randomUUID()
          await tx.execute({
            type: "insert",
            table: LONG_BLOCKS_TABLE,
            value: blockRow(this.composeBlock(blockId, change.content, change.value, now, now), scope),
          })
          await this.applyDetailChanges(tx, scope, blockId, change.content.domain, change.details, now, vectorUpserts, vectorDeletes)
          await this.replaceAliases(tx, scope, blockId, change.content.aliases)
          vectorUpserts.push(blockVectorRecord(scope, blockId, change.content, change.summaryVector))
          blockIds.push(blockId)
        } else if (change.kind === "UPDATE") {
          const existing = await this.assertBlockMatches(tx, scope, change.blockId, change.oldContent, change.oldValue)
          const contentUpdatedAt = this.contentChanged(change.oldContent, change.content, change.details)
            ? now
            : existing.contentUpdatedAt
          await tx.execute({
            type: "upsert",
            table: LONG_BLOCKS_TABLE,
            value: blockRow(this.composeBlock(change.blockId, change.content, change.value, now, contentUpdatedAt), scope),
          })
          await this.applyDetailChanges(tx, scope, change.blockId, change.content.domain, change.details, now, vectorUpserts, vectorDeletes)
          await this.replaceAliases(tx, scope, change.blockId, change.content.aliases)
          if (change.content.lifecycleStatus === "archived") {
            const existing = await this.loadBlockWith(tx, scope, change.blockId)
            for (const detail of existing?.details ?? []) {
              vectorDeletes.push(vectorRecordId("detail", detail.detailId))
            }
            vectorDeletes.push(vectorRecordId("block", change.blockId))
            archivedBlockIds.push(change.blockId)
          } else {
            vectorUpserts.push(blockVectorRecord(scope, change.blockId, change.content, change.summaryVector))
          }
          blockIds.push(change.blockId)
        } else {
          await this.requireBlock(tx, scope, change.blockId)
          const existing = await this.loadBlockWith(tx, scope, change.blockId)
          await tx.execute({
            type: "update",
            table: LONG_BLOCKS_TABLE,
            where: andWhere([eq("block_id", change.blockId), scopeWhere(scope)]),
            patch: { lifecycle_status: "archived", updated_at: now },
          })
          await tx.execute({
            type: "update",
            table: LONG_DETAILS_TABLE,
            where: andWhere([eq("block_id", change.blockId), scopeWhere(scope)]),
            patch: { lifecycle_status: "archived", updated_at: now },
          })
          for (const detail of existing?.details ?? []) {
            vectorDeletes.push(vectorRecordId("detail", detail.detailId))
          }
          vectorDeletes.push(vectorRecordId("block", change.blockId))
          archivedBlockIds.push(change.blockId)
        }
      }
    })

    // 向量变更：vector 缺失时跳过（关系已生效，向量残留不影响正确性）。
    if (this.vector !== undefined) {
      if (vectorDeletes.length > 0) {
        await this.vector.execute({
          type: "deleteMany",
          collection: LONG_VECTOR_COLLECTION,
          ids: vectorDeletes,
        })
      }
      if (vectorUpserts.length > 0) {
        await this.vector.execute({
          type: "upsertMany",
          collection: LONG_VECTOR_COLLECTION,
          values: vectorUpserts,
        })
      }
    }

    const result: LongApplyResult = { blockIds, archivedBlockIds }
    if (options.idempotencyKey !== undefined) {
      this.applied.set(options.idempotencyKey, result)
    }
    return result
  }

  // ────────────────────────────────────────────────────────────────
  // 内部辅助
  // ────────────────────────────────────────────────────────────────

  /** 通过 title 与 alias 的规范化完全匹配收集块摘要。 */
  private async collectTitleMatches(
    scope: Scope,
    queryKey: string,
    into: Map<string, LongBlockSummary>,
  ): Promise<void> {
    const relational = this.requireRelational()
    const [titleResult, aliasResult] = await Promise.all([
      relational.execute({
        type: "find",
        table: LONG_BLOCKS_TABLE,
        where: andWhere([
          scopeWhere(scope),
          eq("title_key", queryKey),
          inSet("lifecycle_status", [...SEARCHABLE_LIFECYCLE]),
        ]),
      }),
      relational.execute({
        type: "find",
        table: LONG_ALIASES_TABLE,
        where: andWhere([eq("memory_space_id", scope.memorySpaceId), eq("alias_key", queryKey)]),
      }),
    ])
    for (const row of titleResult.rows) {
      const block = blockFromRow(row)
      into.set(block.blockId, await this.summarize(block))
    }
    if (aliasResult.rows.length > 0) {
      const aliasBlockIds = aliasResult.rows.map((row) => String(row.block_id))
      const blocks = await relational.execute({
        type: "find",
        table: LONG_BLOCKS_TABLE,
        where: andWhere([
          scopeWhere(scope),
          inSet("block_id", aliasBlockIds),
          inSet("lifecycle_status", [...SEARCHABLE_LIFECYCLE]),
        ]),
      })
      for (const row of blocks.rows) {
        const block = blockFromRow(row)
        into.set(block.blockId, await this.summarize(block))
      }
    }
  }

  /** 通过块 summary 向量召回块，结果写入 Map<blockId, score>。 */
  private async collectBlockVector(
    scope: Scope,
    queryVector: readonly number[],
    into: Map<string, number>,
  ): Promise<void> {
    const adapter = this.requireVector()
    const { matches } = await adapter.execute({
      type: "search",
      collection: LONG_VECTOR_COLLECTION,
      vector: queryVector,
      where: vectorAnd([
        vectorEq("userId", scope.userId),
        vectorEq("memorySpaceId", scope.memorySpaceId),
        vectorEq("recordType", "block"),
      ]),
      limit: this.config.blockMaxResults + this.config.blockMinResults,
    })
    const ranked = rankMatches(
      matches,
      this.config.blockVectorThreshold,
      this.config.blockMinResults,
      this.config.blockMaxResults,
    )
    for (const item of ranked) {
      into.set(item.match.id.slice(BLOCK_ID_PREFIX.length), item.score)
    }
  }

  /** 强检索的平级向量检索：块 summary 与细节 summary 一起返回。 */
  private async collectStrongVector(
    scope: Scope,
    queryVector: readonly number[],
    into: { kind: "block" | "detail"; blockId: string; detailId: string | null; score: number }[],
  ): Promise<void> {
    const limit = this.config.strongMaxResults + this.config.strongMinResults
    const { matches } = await this.requireVector().execute({
      type: "search",
      collection: LONG_VECTOR_COLLECTION,
      vector: queryVector,
      where: vectorAnd([
        vectorEq("userId", scope.userId),
        vectorEq("memorySpaceId", scope.memorySpaceId),
      ]),
      limit,
    })
    const ranked = rankMatches(
      matches,
      this.config.strongVectorThreshold,
      this.config.strongMinResults,
      this.config.strongMaxResults,
    )
    for (const item of ranked) {
      const decoded = decodeVectorRecord(item.match)
      if (decoded !== null) {
        into.push({ ...decoded, score: item.score })
      }
    }
  }

  /** 在单个块内做细节 summary 向量检索，并回表补全正文。 */
  private async collectDetailVector(
    scope: Scope,
    block: LongBlock,
    queryVector: readonly number[],
  ): Promise<LongDetailHit[]> {
    const adapter = this.requireVector()
    const { matches } = await adapter.execute({
      type: "search",
      collection: LONG_VECTOR_COLLECTION,
      vector: queryVector,
      where: vectorAnd([
        vectorEq("userId", scope.userId),
        vectorEq("memorySpaceId", scope.memorySpaceId),
        vectorEq("recordType", "detail"),
        vectorEq("blockId", block.blockId),
      ]),
      limit: this.config.detailMaxPerBlock + this.config.detailMinPerBlock,
    })
    const ranked = rankMatches(
      matches,
      this.config.detailVectorThreshold,
      this.config.detailMinPerBlock,
      this.config.detailMaxPerBlock,
    )
    const pairs = ranked.map((item) => ({
      detailId: item.match.id.slice(DETAIL_ID_PREFIX.length),
      score: item.score,
    }))
    return this.materializeDetailHits(scope, block, pairs)
  }

  /** 根据 detailId + score 列表回表补全 detail 的 summary 与 body。 */
  private async materializeDetailHits(
    scope: Scope,
    block: LongBlock,
    hits: { detailId: string; score: number }[],
  ): Promise<LongDetailHit[]> {
    if (hits.length === 0) {
      return []
    }
    const byId = new Map(hits.map((hit) => [hit.detailId, hit.score]))
    const result = await this.requireRelational().execute({
      type: "find",
      table: LONG_DETAILS_TABLE,
      where: andWhere([
        scopeWhere(scope),
        eq("block_id", block.blockId),
        inSet("detail_id", [...byId.keys()]),
        inSet("lifecycle_status", [...SEARCHABLE_LIFECYCLE]),
      ]),
    })
    const details = result.rows.map(detailFromRow)
    details.sort(
      (a, b) =>
        (byId.get(b.detailId) ?? -1) - (byId.get(a.detailId) ?? -1) ||
        (a.detailId < b.detailId ? -1 : a.detailId > b.detailId ? 1 : 0),
    )
    return details.map((detail) => ({
      detailId: detail.detailId,
      summary: detail.summary,
      body: detail.body,
      score: byId.get(detail.detailId) ?? null,
    }))
  }

  /** 读完整块（块 + 别名 + 全部细节）。 */
  private loadBlock(scope: Scope, blockId: string): Promise<LongBlock | null> {
    return this.loadBlockWith(this.requireRelational(), scope, blockId)
  }

  /** 在指定 executor 上读完整块（事务内外通用）。 */
  private async loadBlockWith(
    executor: RelationalExecutor,
    scope: Scope,
    blockId: string,
  ): Promise<LongBlock | null> {
    const rowResult = await executor.execute({ type: "get", table: LONG_BLOCKS_TABLE, key: blockId })
    if (rowResult.row === undefined) {
      return null
    }
    const block = blockFromRow(rowResult.row)
    if (block.userId !== scope.userId || block.memorySpaceId !== scope.memorySpaceId) {
      return null
    }
    const [aliasResult, detailResult] = await Promise.all([
      executor.execute({
        type: "find",
        table: LONG_ALIASES_TABLE,
        where: eq("block_id", blockId),
        orderBy: [{ field: "alias_key", direction: "asc" }],
      }),
      executor.execute({
        type: "find",
        table: LONG_DETAILS_TABLE,
        where: eq("block_id", blockId),
        orderBy: [{ field: "created_at", direction: "asc" }],
      }),
    ])
    return {
      blockId: block.blockId,
      domain: block.domain,
      title: block.title,
      aliases: aliasResult.rows.map((row) => String(row.alias)),
      summary: block.summary,
      overviewBody: block.overviewBody,
      lifecycleStatus: block.lifecycleStatus,
      value: block.value,
      details: detailResult.rows.map(detailFromRow),
      createdAt: block.createdAt,
      updatedAt: block.updatedAt,
      contentUpdatedAt: block.contentUpdatedAt,
    }
  }

  /** 由块行生成轻量摘要（含别名）。 */
  private async summarize(block: ReturnType<typeof blockFromRow>): Promise<LongBlockSummary> {
    const aliases = await this.requireRelational().execute({
      type: "find",
      table: LONG_ALIASES_TABLE,
      where: eq("block_id", block.blockId),
      orderBy: [{ field: "alias_key", direction: "asc" }],
    })
    return {
      blockId: block.blockId,
      domain: block.domain,
      title: block.title,
      aliases: aliases.rows.map((row) => String(row.alias)),
      summary: block.summary,
      lifecycleStatus: block.lifecycleStatus,
      updatedAt: block.updatedAt,
    }
  }

  /** 应用细节变更（CREATE/UPDATE/ARCHIVE），并收集向量 upsert/delete。 */
  private async applyDetailChanges(
    tx: RelationalExecutor,
    scope: Scope,
    blockId: string,
    domain: LongDomain,
    changes: readonly LongDetailChange[],
    now: string,
    vectorUpserts: VectorRecord[],
    vectorDeletes: string[],
  ): Promise<void> {
    for (const change of changes) {
      if (change.kind === "CREATE") {
        const detailId = randomUUID()
        await tx.execute({
          type: "insert",
          table: LONG_DETAILS_TABLE,
          value: detailRow(
            {
              detailId,
              summary: change.summary,
              body: change.body,
              lifecycleStatus: change.lifecycleStatus,
              value: change.value,
              createdAt: now,
              updatedAt: now,
            },
            blockId,
            scope,
          ),
        })
        vectorUpserts.push(detailVectorRecord(scope, domain, blockId, detailId, change.summary, change.summaryVector))
      } else if (change.kind === "UPDATE") {
        const result = await tx.execute({
          type: "update",
          table: LONG_DETAILS_TABLE,
          where: andWhere([eq("detail_id", change.detailId), eq("block_id", blockId), scopeWhere(scope)]),
          patch: {
            summary: change.summary,
            body: change.body,
            lifecycle_status: change.lifecycleStatus,
            value_version: change.value.valueVersion,
            value_state: change.value.valueData,
            updated_at: now,
          },
        })
        if (result.affectedRows !== 1) {
          throw new LongMemoryError("detail-not-found", `细节 '${change.detailId}' 不存在或不属于该块`)
        }
        if (change.lifecycleStatus === "archived") {
          vectorDeletes.push(vectorRecordId("detail", change.detailId))
        } else {
          vectorUpserts.push(detailVectorRecord(scope, domain, blockId, change.detailId, change.summary, change.summaryVector))
        }
      } else {
        const result = await tx.execute({
          type: "update",
          table: LONG_DETAILS_TABLE,
          where: andWhere([eq("detail_id", change.detailId), eq("block_id", blockId), scopeWhere(scope)]),
          patch: { lifecycle_status: "archived", updated_at: now },
        })
        if (result.affectedRows !== 1) {
          throw new LongMemoryError("detail-not-found", `细节 '${change.detailId}' 不存在或不属于该块`)
        }
        vectorDeletes.push(vectorRecordId("detail", change.detailId))
      }
    }
  }

  /** 将别名列表与库中现有别名 diff 后替换。 */
  private async replaceAliases(
    tx: RelationalExecutor,
    scope: Scope,
    blockId: string,
    aliases: readonly string[],
  ): Promise<void> {
    const existing = await tx.execute({
      type: "find",
      table: LONG_ALIASES_TABLE,
      where: eq("block_id", blockId),
    })
    const existingKeys = new Map(
      existing.rows.map((row) => [String(row.alias_key), String(row.alias_id)]),
    )
    const nextKeys = new Map(aliases.map((alias) => [normalizeKey(alias), alias]))
    for (const [key, aliasId] of existingKeys) {
      if (!nextKeys.has(key)) {
        await tx.execute({ type: "delete", table: LONG_ALIASES_TABLE, where: eq("alias_id", aliasId) })
      }
    }
    for (const [key, alias] of nextKeys) {
      if (!existingKeys.has(key)) {
        await tx.execute({ type: "insert", table: LONG_ALIASES_TABLE, value: aliasRow(blockId, scope, alias, key) })
      }
    }
  }

  /** 组合可写入关系表行的块对象（details 单独成表，此处占位）。 */
  private composeBlock(
    blockId: string,
    content: LongBlockContent,
    value: ValueState,
    now: string,
    contentUpdatedAt: string,
  ): LongBlock {
    return {
      blockId,
      domain: content.domain,
      title: content.title,
      aliases: content.aliases,
      summary: content.summary,
      overviewBody: content.overviewBody,
      lifecycleStatus: content.lifecycleStatus,
      value,
      details: [],
      createdAt: now,
      updatedAt: now,
      contentUpdatedAt,
    }
  }

  /** 校验 UPDATE 的旧信息与库中一致，防止应用过期变更；返回库中当前行，供 contentUpdatedAt 保留。 */
  private async assertBlockMatches(
    tx: RelationalExecutor,
    scope: Scope,
    blockId: string,
    oldContent: LongBlockContent,
    oldValue: ValueState,
  ): Promise<BlockRow> {
    const result = await tx.execute({ type: "get", table: LONG_BLOCKS_TABLE, key: blockId })
    if (result.row === undefined) {
      throw new LongMemoryError("block-not-found", `块 '${blockId}' 不存在`)
    }
    const block = blockFromRow(result.row)
    if (block.userId !== scope.userId || block.memorySpaceId !== scope.memorySpaceId) {
      throw new LongMemoryError("block-not-found", `块 '${blockId}' 不属于该空间`)
    }
    const matches =
      block.domain === oldContent.domain &&
      block.title === oldContent.title &&
      block.summary === oldContent.summary &&
      block.overviewBody === oldContent.overviewBody &&
      block.lifecycleStatus === oldContent.lifecycleStatus &&
      block.value.valueVersion === oldValue.valueVersion &&
      JSON.stringify(block.value.valueData) === JSON.stringify(oldValue.valueData)
    if (!matches) {
      throw new LongMemoryError("conflict", `块 '${blockId}' 已被并发修改，old 信息不一致`)
    }
    return block
  }

  /** 判断 UPDATE 是否改变了正文内容（不含 lifecycle 与价值），用于决定是否刷新 contentUpdatedAt。 */
  private contentChanged(
    oldContent: LongBlockContent,
    content: LongBlockContent,
    details: readonly LongDetailChange[],
  ): boolean {
    if (
      oldContent.domain !== content.domain ||
      oldContent.title !== content.title ||
      oldContent.summary !== content.summary ||
      oldContent.overviewBody !== content.overviewBody
    ) {
      return true
    }
    if (!this.sameAliases(oldContent.aliases, content.aliases)) {
      return true
    }
    return details.some(
      (detail) =>
        detail.kind === "CREATE" ||
        detail.kind === "ARCHIVE" ||
        (detail.kind === "UPDATE" && (detail.oldSummary !== detail.summary || detail.oldBody !== detail.body)),
    )
  }

  /** 别名列表按集合比较（顺序无关）。 */
  private sameAliases(left: readonly string[], right: readonly string[]): boolean {
    if (left.length !== right.length) {
      return false
    }
    const set = new Set(left)
    return right.every((alias) => set.has(alias))
  }

  /** 校验块存在且属于 scope。 */
  private async requireBlock(
    tx: RelationalExecutor,
    scope: Scope,
    blockId: string,
  ): Promise<void> {
    const result = await tx.execute({ type: "get", table: LONG_BLOCKS_TABLE, key: blockId })
    if (result.row === undefined) {
      throw new LongMemoryError("block-not-found", `块 '${blockId}' 不存在`)
    }
    const block = blockFromRow(result.row)
    if (block.userId !== scope.userId || block.memorySpaceId !== scope.memorySpaceId) {
      throw new LongMemoryError("block-not-found", `块 '${blockId}' 不属于该空间`)
    }
  }

  /** 校验变更集合：块/细节引用不重复、新建块细节只能用 CREATE、字段枚举与容量合法。 */
  private assertChangeSet(changeSet: LongChangeSet): void {
    const blockIds = new Set<string>()
    for (const change of changeSet.changes) {
      if (change.kind !== "CREATE") {
        if (blockIds.has(change.blockId)) {
          throw new LongMemoryError("duplicate-change", `块 '${change.blockId}' 在本次变更中出现多次`)
        }
        blockIds.add(change.blockId)
      }
      if (change.kind === "ARCHIVE") {
        continue
      }
      this.assertContent(change.content)
      if (change.kind === "CREATE") {
        for (const detail of change.details) {
          if (detail.kind !== "CREATE") {
            throw new LongMemoryError("invalid-input", "新建块的细节只能使用 CREATE")
          }
          this.assertDetailChange(detail)
        }
      } else {
        const detailIds = new Set<string>()
        for (const detail of change.details) {
          if (detail.kind !== "CREATE") {
            if (detailIds.has(detail.detailId)) {
              throw new LongMemoryError("duplicate-change", `细节 '${detail.detailId}' 在本次变更中出现多次`)
            }
            detailIds.add(detail.detailId)
          }
          this.assertDetailChange(detail)
        }
      }
    }
  }

  /** 校验块可变内容的枚举与容量硬阈值。 */
  private assertContent(content: LongBlockContent): void {
    assertDomain(content.domain)
    assertLifecycle(content.lifecycleStatus)
    if (charCount(content.title) > this.config.blockTitleHard) {
      throw new LongMemoryError("invalid-input", `块 title 超过 ${this.config.blockTitleHard} 字符`)
    }
    if (charCount(content.summary) > this.config.blockSummaryHard) {
      throw new LongMemoryError("invalid-input", `块 summary 超过 ${this.config.blockSummaryHard} 字符`)
    }
    if (charCount(content.overviewBody) > this.config.overviewBodyHard) {
      throw new LongMemoryError("invalid-input", `当下概括 body 超过 ${this.config.overviewBodyHard} 字符`)
    }
  }

  /** 校验细节变更的枚举与容量硬阈值。 */
  private assertDetailChange(change: LongDetailChange): void {
    if (change.kind === "ARCHIVE") {
      return
    }
    assertLifecycle(change.lifecycleStatus)
    if (charCount(change.summary) > this.config.detailSummaryHard) {
      throw new LongMemoryError("invalid-input", `细节 summary 超过 ${this.config.detailSummaryHard} 字符`)
    }
    if (charCount(change.body) > this.config.detailBodyHard) {
      throw new LongMemoryError("invalid-input", `细节 body 超过 ${this.config.detailBodyHard} 字符`)
    }
  }

  /** 计算检索分支状态。 */
  private searchStatus(
    blocks: LongBlockHit[],
    queryVector: readonly number[] | null,
    vector: VectorAdapter | undefined,
    flags: Record<string, boolean>,
  ): LongSearchResult["status"] {
    if (queryVector === null || vector === undefined) {
      return flags.title ? "COMPLETE" : "UNAVAILABLE"
    }
    if (Object.values(flags).every(Boolean)) {
      return "COMPLETE"
    }
    return blocks.length > 0 ? "PARTIAL" : "UNAVAILABLE"
  }

  private requireRelational(): RelationalAdapter {
    if (this.relational === undefined) {
      throw new LongMemoryError("source-not-ready", "关系型存储实例尚未初始化")
    }
    return this.relational
  }

  private requireVector(): VectorAdapter {
    if (this.vector === undefined) {
      throw new LongMemoryError("source-not-ready", "向量存储实例尚未就绪")
    }
    return this.vector
  }
}

export default LongMemory

// ---------------------------------------------------------------------------
// 模块级辅助（不对外导出）
// ---------------------------------------------------------------------------

function vectorEq(field: string, value: string): VectorEqualFilter {
  return { type: "eq", field, value }
}

function vectorAnd(conditions: readonly VectorEqualFilter[]): VectorFilter {
  return { type: "and", conditions: [...conditions] }
}

function blockVectorRecord(
  scope: Scope,
  blockId: string,
  content: Pick<LongBlockContent, "domain" | "summary">,
  summaryVector: readonly number[],
): VectorRecord {
  return {
    id: vectorRecordId("block", blockId),
    vector: summaryVector,
    fields: {
      userId: scope.userId,
      memorySpaceId: scope.memorySpaceId,
      domain: content.domain,
      blockId,
      recordType: "block",
    },
    payload: { blockId, summary: content.summary },
  }
}

function detailVectorRecord(
  scope: Scope,
  domain: LongDomain,
  blockId: string,
  detailId: string,
  summary: string,
  summaryVector: readonly number[],
): VectorRecord {
  return {
    id: vectorRecordId("detail", detailId),
    vector: summaryVector,
    fields: {
      userId: scope.userId,
      memorySpaceId: scope.memorySpaceId,
      domain,
      blockId,
      recordType: "detail",
    },
    payload: { blockId, detailId, summary },
  }
}

/** 按阈值保留、不足最低数量补足、超过最大数量截取；输入已按距离升序。 */
function rankMatches(
  matches: readonly VectorMatch[],
  threshold: number,
  min: number,
  max: number,
): { match: VectorMatch; score: number }[] {
  const scored = matches.map((match) => ({ match, score: 1 - match.distance }))
  const above = scored.filter((item) => item.score >= threshold)
  const below = scored.filter((item) => item.score < threshold)
  const take = Math.min(max, Math.max(min, above.length))
  return above.length >= take ? above.slice(0, take) : [...above, ...below].slice(0, take)
}

/** 从平级向量命中项解码类型、所属块与细节 ID。 */
function decodeVectorRecord(match: VectorMatch): {
  kind: "block" | "detail"
  blockId: string
  detailId: string | null
} | null {
  const blockId = typeof match.payload?.blockId === "string" ? match.payload.blockId : null
  if (blockId === null) {
    return null
  }
  if (match.id.startsWith(DETAIL_ID_PREFIX)) {
    const detailId = typeof match.payload?.detailId === "string" ? match.payload.detailId : null
    if (detailId === null) {
      return null
    }
    return { kind: "detail", blockId, detailId }
  }
  if (match.id.startsWith(BLOCK_ID_PREFIX)) {
    return { kind: "block", blockId, detailId: null }
  }
  return null
}

function assertScope(scope: Scope): void {
  assertNonEmpty(scope.userId, "scope.userId")
  assertNonEmpty(scope.memorySpaceId, "scope.memorySpaceId")
}

function assertQuery(query: string): void {
  assertNonEmpty(query, "query")
}

function assertDomain(domain: LongDomain): void {
  const domains: readonly LongDomain[] = ["self", "person", "project", "topic", "entity", "event"]
  if (!domains.includes(domain)) {
    throw new LongMemoryError("invalid-input", `domain 必须是合法枚举，收到 '${domain}'`)
  }
}

function assertLifecycle(value: LifecycleStatus): void {
  const states: readonly LifecycleStatus[] = ["active", "observing", "archived"]
  if (!states.includes(value)) {
    throw new LongMemoryError("invalid-input", `lifecycleStatus 必须是合法枚举，收到 '${value}'`)
  }
}

/** 按 Unicode 码点计数，而非 UTF-16 码元，与 v2 的字符计数口径一致。 */
function charCount(value: string): number {
  return [...value].length
}

function assertNonEmpty(value: string, name: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new LongMemoryError("invalid-input", `${name} 必须是非空字符串`)
  }
}

function positiveInteger(value: number, name: string, max: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new LongMemoryError("invalid-input", `${name} 必须是 1 到 ${max} 的安全整数`)
  }
  return value
}

function pageLimit(value: number | undefined): number {
  return value === undefined ? 20 : positiveInteger(value, "limit", 100)
}

function assertTimestamp(value: string): void {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new LongMemoryError("invalid-input", "cursor.updatedAt 必须是有效时间字符串")
  }
}
