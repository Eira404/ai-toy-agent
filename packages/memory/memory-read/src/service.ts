import { Service, type Context } from "cordis"
import "toy-embedding"
import "toy-memory-fast"
import "toy-memory-long"
import type { FastSearchResult, Scope } from "toy-memory-fast"
import type { LongSearchResult } from "toy-memory-long"
import { resolveReadConfig, type ReadConfig, type ResolvedReadConfig } from "./config.js"
import { ReadMemoryError } from "./error.js"
import type { ReadMode, ReadSearchInput, ReadSearchResult, ReadStatus } from "./types.js"

declare module "cordis" {
  interface Context {
    memoryRead: MemoryRead
  }
}

/**
 * 记忆联合检索编排服务。
 *
 * 职责：生成一次 Query Embedding，并行调用 Fast 与 Long（按 mode 选择强弱），
 * 汇总整体 `COMPLETE / PARTIAL / UNAVAILABLE` 状态。分支失败只重试该分支，
 * 达到尝试次数或整次截止时间后降级为占位结果，不阻断主 Agent 问答。
 *
 * 依赖：`toy-embedding`（Query 向量）、`toy-memory-fast`、`toy-memory-long`。
 */
export class MemoryRead extends Service {
  static inject = ["embedding", "memoryFast", "memoryLong"]

  private readonly config: ResolvedReadConfig

  /** @param config 装配配置；`embeddingProvider` 与 `embeddingModel` 必填。 */
  constructor(ctx: Context, config: ReadConfig) {
    super(ctx, "memoryRead")
    this.config = resolveReadConfig(config)
  }

  /**
   * 执行一次联合检索，返回 Fast、Long 两组完整结果与整体状态。
   *
   * 流程：共享 Query Embedding → 并行 Fast 与 Long → 汇总状态。Embedding 失败
   * 时降级为 `queryVector = null`，Fast/Long 各自只走 title/alias 完全匹配。
   *
   * @param input 范围、专用检索 Query 与 Long 强弱模式。
   */
  async search(input: ReadSearchInput): Promise<ReadSearchResult> {
    assertScope(input.scope)
    assertQuery(input.query)
    assertMode(input.mode)

    const deadline = this.config.now() + this.config.deadlineMs

    // 1) Query Embedding：失败降级为 null（只走 title/alias 匹配）。
    let queryVector: readonly number[] | null = null
    let embeddingFailed = false
    try {
      queryVector = await retry(
        () => this.embedQuery(input.query),
        this.config.maxAttempts,
        deadline,
        this.config.now,
      )
    } catch {
      embeddingFailed = true
    }

    // 2) 并行 Fast 与 Long：各自带重试，失败降级为占位结果。
    const [fast, long] = await Promise.all([
      this.retryFast(input, queryVector, deadline),
      this.retryLong(input, queryVector, deadline),
    ])

    return { status: overallStatus(embeddingFailed, fast, long), fast, long }
  }

  /** 生成单条 Query 的 Embedding，返回第一维向量。 */
  private async embedQuery(query: string): Promise<readonly number[]> {
    const result = await this.ctx.embedding.embed({
      provider: this.config.embeddingProvider,
      model: this.config.embeddingModel,
      texts: [query],
      operation: "memory-read",
    })
    const vector = result.vectors[0]
    if (vector === undefined) {
      throw new Error("Embedding 返回空向量")
    }
    return vector
  }

  /** Fast 分支：带重试，耗尽后降级为全失败占位结果。 */
  private retryFast(
    input: ReadSearchInput,
    queryVector: readonly number[] | null,
    deadline: number,
  ): Promise<FastSearchResult> {
    return retry(
      () => this.ctx.memoryFast.search({ scope: input.scope, query: input.query, queryVector }),
      this.config.maxAttempts,
      deadline,
      this.config.now,
    ).catch((): FastSearchResult => ({ titleSucceeded: false, vectorSucceeded: false, hits: [] }))
  }

  /** Long 分支：按 mode 选择强弱，带重试，耗尽后降级为 UNAVAILABLE 占位结果。 */
  private retryLong(
    input: ReadSearchInput,
    queryVector: readonly number[] | null,
    deadline: number,
  ): Promise<LongSearchResult> {
    const call = () =>
      input.mode === "weak"
        ? this.ctx.memoryLong.searchWeak({ scope: input.scope, query: input.query, queryVector })
        : this.ctx.memoryLong.searchStrong({ scope: input.scope, query: input.query, queryVector })
    return retry(call, this.config.maxAttempts, deadline, this.config.now).catch(
      (): LongSearchResult => ({ status: "UNAVAILABLE", blocks: [] }),
    )
  }
}

export default MemoryRead

// ---------------------------------------------------------------------------
// 模块级辅助
// ---------------------------------------------------------------------------

/**
 * 带截止时间的重试：每次尝试前检查 deadline，达到后停止重试。
 *
 * @param fn 要执行的操作。
 * @param maxAttempts 含首次的最大尝试次数。
 * @param deadline 整次操作的截止毫秒时间戳。
 * @param now 时间源（毫秒）。
 * @returns 首次成功的结果。
 * @throws 达到重试上限或截止时间后，抛出最后一次错误或截止错误。
 */
async function retry<T>(
  fn: () => Promise<T>,
  maxAttempts: number,
  deadline: number,
  now: () => number,
): Promise<T> {
  let lastError: unknown
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (now() >= deadline) {
      throw new Error("检索截止时间已到")
    }
    try {
      return await fn()
    } catch (error) {
      lastError = error
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

/**
 * 汇总整体检索状态（对应 v2 §9.6 三态）。
 *
 * Embedding 失败本身就让结果降级为 PARTIAL（向量分支整体未执行），
 * 即使 title/alias 匹配全部成功。
 */
function overallStatus(
  embeddingFailed: boolean,
  fast: FastSearchResult,
  long: LongSearchResult,
): ReadStatus {
  const hasResult = fast.hits.length > 0 || long.blocks.length > 0
  const complete =
    !embeddingFailed &&
    fast.titleSucceeded &&
    fast.vectorSucceeded &&
    long.status === "COMPLETE"
  if (complete) {
    return "COMPLETE"
  }
  return hasResult ? "PARTIAL" : "UNAVAILABLE"
}

function assertScope(scope: Scope): void {
  assertNonEmpty(scope.userId, "scope.userId")
  assertNonEmpty(scope.memorySpaceId, "scope.memorySpaceId")
}

function assertQuery(query: string): void {
  assertNonEmpty(query, "query")
}

function assertMode(mode: ReadMode): void {
  if (mode !== "weak" && mode !== "strong") {
    throw new ReadMemoryError("invalid-input", `mode 必须是 weak 或 strong，收到 '${mode}'`)
  }
}

function assertNonEmpty(value: string, name: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ReadMemoryError("invalid-input", `${name} 必须是非空字符串`)
  }
}
