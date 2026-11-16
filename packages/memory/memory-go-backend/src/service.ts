import { Service, type Context } from "cordis"
import "toy-backend-http"
import "toy-memory-space"
import "toy-memory-read"
import "toy-memory-write"
import "toy-memory-scheduler"
import type { ReadMode, ReadSearchResult } from "toy-memory-read"
import {
  randomDailyAt,
  resolveGoBackendConfig,
  type GoBackendConfig,
  type ResolvedGoBackendConfig,
} from "./config.js"
import type {
  MemoryContext,
  MemoryDraft,
  ReadMemoryInput,
  ReadMemoryResult,
  WriteMemoryInput,
  WriteMemoryResult,
} from "./types.js"

declare module "cordis" {
  interface Context {
    memoryGoBackend: MemoryGoBackend
  }
}

/**
 * 记忆读写 HTTP 门面（临时，仅供 Go conversation 调用）。
 *
 * 职责：把 Go 的 `POST /memory/read` 与 `POST /memory/write` 两条请求映射到
 * `toy-memory-read` / `toy-memory-write`。空间不在请求里，门面内部按
 * `userId + deviceId` 用 `resolveOrCreateMemorySpace` 解析或创建；新建空间时
 * 自动挂一份 daily 调度（默认 03:00 / Asia/Shanghai / 阈值 10）。
 *
 * 本包不接 `toy-memory-tools` / `toy-memory-lifecycle`，与 v4 在线工具路径无关。
 */
export class MemoryGoBackend extends Service {
  static inject = ["http", "memorySpace", "memoryRead", "memoryWrite", "memoryScheduler"]

  private readonly config: ResolvedGoBackendConfig

  /** @param config 可选；控制新建空间时自动挂载的 daily 调度默认值。 */
  constructor(ctx: Context, config: GoBackendConfig = {}) {
    super(ctx, "memoryGoBackend")
    this.config = resolveGoBackendConfig(config)
    ctx.effect(() => this.registerRoutes(), "memoryGoBackend.routes")
  }

  /** 注册两条 HTTP 路由，返回注销函数。 */
  private registerRoutes(): () => void {
    const { http } = this.ctx
    const disposers = [
      http.post("/memory/read", (c) => this.readMemory(c.body as ReadMemoryInput)),
      http.post("/memory/write", (c) => this.writeMemory(c.body as WriteMemoryInput)),
    ]
    return () => {
      for (const dispose of disposers) {
        dispose()
      }
    }
  }

  /**
   * 执行一次联合检索：解析/创建空间（新建则挂 daily 调度）→ memoryRead.search → 精简正文。
   *
   * @param input 上下文、专用检索 Query 与可选强弱模式。
   * @returns 整体状态 + Fast/Long 正文（已去掉内部 ID/分数）。
   */
  async readMemory(input: ReadMemoryInput): Promise<ReadMemoryResult> {
    const context = this.assertContext(input.context)
    assertNonEmpty(input.query, "query")
    const { memorySpaceId } = await this.resolveScope(context)
    const mode: ReadMode = input.mode === "strong" ? "strong" : "weak"
    const result = await this.ctx.memoryRead.search({
      scope: { userId: context.userId, memorySpaceId },
      query: input.query,
      mode,
    })
    return formatReadResult(result)
  }

  /**
   * 直接写入一批记忆：解析/创建空间（新建则挂 daily 调度）→ memoryWrite.write → 投影 records。
   *
   * @param input 上下文与主模型生成的 title/summary/body 数组。
   * @returns 写入批次 ID 与已落库记录的正文投影。
   */
  async writeMemory(input: WriteMemoryInput): Promise<WriteMemoryResult> {
    const context = this.assertContext(input.context)
    const memories = assertMemories(input.memories)
    const { memorySpaceId } = await this.resolveScope(context)
    const result = await this.ctx.memoryWrite.write({
      scope: { userId: context.userId, memorySpaceId },
      sessionId: context.sessionId,
      turnId: context.turnId,
      drafts: memories,
    })
    return {
      kind: result.kind,
      writeId: result.writeId,
      records: result.records.map((record) => ({
        title: record.title,
        summary: record.summary,
        body: record.body,
      })),
    }
  }

  /** 解析/创建空间；新建时自动挂 daily 调度。 */
  private async resolveScope(
    context: MemoryContext,
  ): Promise<{ readonly memorySpaceId: string; readonly created: boolean }> {
    const result = await this.ctx.memorySpace.resolveOrCreateMemorySpace(context.userId, context.deviceId)
    if (result.created) {
      await this.ensureDailySchedule(context.userId, result.memorySpaceId)
    }
    return result
  }

  /**
   * 为新建空间写一份 daily 调度（由 `toy-memory-scheduler` 到点执行）。
   *
   * `dailyAt` 未显式配置时，对每个空间单独随机取 02:00–02:59 的分钟，避免
   * 大量空间在同一时刻触发 Daily。
   */
  private async ensureDailySchedule(userId: string, memorySpaceId: string): Promise<void> {
    await this.ctx.memoryScheduler.setDailySchedule({
      userId,
      memorySpaceId,
      dailyAt: this.config.dailyAt ?? randomDailyAt(),
      timeZone: this.config.timeZone,
      minPendingFast: this.config.minPendingFast,
    })
  }

  /** 校验 context 四个字段均非空，返回规整后的对象。 */
  private assertContext(context: unknown): MemoryContext {
    if (typeof context !== "object" || context === null) {
      throw invalidInput("context 必须是对象")
    }
    const c = context as Record<string, unknown>
    assertNonEmpty(c.userId, "context.userId")
    assertNonEmpty(c.deviceId, "context.deviceId")
    assertNonEmpty(c.sessionId, "context.sessionId")
    assertNonEmpty(c.turnId, "context.turnId")
    return {
      userId: c.userId as string,
      deviceId: c.deviceId as string,
      sessionId: c.sessionId as string,
      turnId: c.turnId as string,
    }
  }
}

export default MemoryGoBackend

// ---------------------------------------------------------------------------
// 模块级辅助
// ---------------------------------------------------------------------------

/** 把联合检索结果精简成交给 Go 主模型的 JSON（只留正文，去掉内部 ID/分数）。 */
function formatReadResult(result: ReadSearchResult): ReadMemoryResult {
  return {
    status: result.status,
    fast: result.fast.hits.map((hit) => ({
      title: hit.record.title,
      summary: hit.record.summary,
      body: hit.record.body,
    })),
    long: result.long.blocks.map((block) => ({
      title: block.title,
      summary: block.summary,
      overviewBody: block.overviewBody,
      details: block.details.map((detail) => ({ summary: detail.summary, body: detail.body })),
    })),
  }
}

/** 校验 memories 为非空数组且每项 title/summary/body 非空。 */
function assertMemories(value: unknown): readonly MemoryDraft[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw invalidInput("memories 必须是非空数组")
  }
  for (const item of value) {
    if (typeof item !== "object" || item === null) {
      throw invalidInput("memories 每项必须是对象")
    }
    const draft = item as Record<string, unknown>
    assertNonEmpty(draft.title, "memories[].title")
    assertNonEmpty(draft.summary, "memories[].summary")
    assertNonEmpty(draft.body, "memories[].body")
  }
  return value as readonly MemoryDraft[]
}

function assertNonEmpty(value: unknown, name: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw invalidInput(`${name} 必须是非空字符串`)
  }
}

/** 构造带 `code` 的业务错误，由 `toy-backend-http` 归一为 400 响应。 */
function invalidInput(message: string): Error {
  return Object.assign(new Error(message), { code: "invalid-input" })
}
