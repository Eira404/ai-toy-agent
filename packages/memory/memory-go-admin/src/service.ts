import { Service, type Context } from "cordis"
import "toy-admin"
import "toy-memory-space"
import "toy-memory-fast"
import "toy-memory-long"
import "toy-memory-daily"
import "toy-storage"
import { AdminError, type AdminOperationDefinition, type AdminRole } from "toy-admin"
import type { FastCursor, ListFastInput } from "toy-memory-fast"
import type { ListLongInput, LongBlockCursor } from "toy-memory-long"
import { DailyMemoryError } from "toy-memory-daily"
import { DEVICES_TABLE, SPACES_TABLE, type DeviceBinding } from "toy-memory-space"
import type { RelationalAdapter, RelationalRecord } from "toy-storage-relational"
import {
  resolveMemoryGoAdminConfig,
  type MemoryGoAdminConfig,
  type ResolvedMemoryGoAdminConfig,
} from "./config.js"
import {
  fastRecordSchema,
  getFastInputSchema,
  getLongInputSchema,
  listFastInputSchema,
  listFastOutputSchema,
  listLongInputSchema,
  listLongOutputSchema,
  listUserOverviewInputSchema,
  listUserOverviewOutputSchema,
  listUsersInputSchema,
  listUsersOutputSchema,
  longBlockSchema,
  runDailyInputSchema,
  runDailyOutputSchema,
  dailyStatusOutputSchema,
  getDailyStatusInputSchema,
} from "./schemas.js"
import type {
  DailyStatusOutput,
  GetDailyStatusQuery,
  GetFastOutput,
  GetFastQuery,
  GetLongOutput,
  GetLongQuery,
  ListFastOutput,
  ListFastQuery,
  ListLongOutput,
  ListLongQuery,
  ListUserOverviewOutput,
  ListUserOverviewQuery,
  ListUsersOutput,
  ListUsersQuery,
  RunDailyOutput,
  RunDailyQuery,
  UserPage,
} from "./types.js"

declare module "cordis" {
  interface Context {
    memoryGoAdmin: MemoryGoAdmin
  }
}

/** 元信息能力：viewer 可读。 */
const META_ROLES: readonly AdminRole[] = ["superadmin", "admin", "viewer"]
/** 记忆正文能力：视为 PII，只给 admin/superadmin。 */
const CONTENT_ROLES: readonly AdminRole[] = ["superadmin", "admin"]

const LONG_DOMAINS = ["self", "person", "project", "topic", "entity", "event"] as const
const LONG_LIFECYCLES = ["active", "observing", "archived"] as const
const LONG_ORDER_BYS = ["updatedAt", "createdAt"] as const

/** listUsers 每次扫描读取的行数，避免一次性拉取全表。 */
const USER_SCAN_BATCH = 200
const DEFAULT_USER_LIMIT = 20

/**
 * Go 记忆系统的运维管理插件。
 *
 * 职责：通过 `toy-admin` 注册 6 个只读能力，把「按 userId / 记忆空间浏览
 * Fast 与 Long 记忆」暴露给管理员 HTTP 后端。本包只读不写，不接 Session /
 * 工具链；正文级能力默认不授予 viewer。
 *
 * 「用户读取」属于临时/测试实现：本后端没有真正的用户表，只能从记忆空间表
 * 的 `user_id` 推导，因此直接落在本包内读关系表，不污染 `toy-memory-space`；
 * 真正的用户读取应由专门的用户包提供。
 */
export class MemoryGoAdmin extends Service {
  static inject = ["storage", "admin", "memorySpace", "memoryFast", "memoryLong", "memoryDaily"]

  private readonly config: ResolvedMemoryGoAdminConfig
  private relational: RelationalAdapter | undefined

  constructor(ctx: Context, config: MemoryGoAdminConfig = {}) {
    super(ctx, "memoryGoAdmin")
    this.config = resolveMemoryGoAdminConfig(config)
    ctx.effect(() => {
      const disposers = this.buildOperations().map((definition) => ctx.admin.register(definition))
      return () => {
        for (const dispose of disposers) {
          dispose()
        }
      }
    }, "memoryGoAdmin.operations")
  }

  /** 核对命名关系型实例，供临时用户读取使用。 */
  [Service.init](): void {
    const relational = this.ctx.storage.tryGet<RelationalAdapter>(
      "relational",
      this.config.relationalSource,
    )
    if (relational === undefined) {
      throw new AdminError(
        "source-not-ready",
        `关系型存储实例 'relational/${this.config.relationalSource}' 尚未就绪`,
      )
    }
    this.relational = relational
  }

  private buildOperations(): readonly AdminOperationDefinition[] {
    return [
      this.listUsersOperation(),
      this.listUserOverviewOperation(),
      this.listFastOperation(),
      this.getFastOperation(),
      this.listLongOperation(),
      this.getLongOperation(),
      this.runDailyOperation(),
      this.getDailyStatusOperation(),
    ]
  }

  private listUsersOperation(): AdminOperationDefinition<ListUsersQuery, ListUsersOutput> {
    return {
      name: "memory.admin.list-users",
      description: "列出记忆空间中已出现的 userId（去重，按 userId 升序分页）",
      roles: META_ROLES,
      kind: "query",
      bindings: [{ transport: "http", method: "GET", path: "/memory/users" }],
      input: listUsersInputSchema,
      output: listUsersOutputSchema,
      audit: (input) => ({ limit: input.limit ?? null, before: input.before ?? null }),
      execute: async (input) => {
        const limit = input.limit === undefined ? DEFAULT_USER_LIMIT : parseLimit(input.limit)
        return this.listUsers({
          limit,
          ...(input.before === undefined ? {} : { before: input.before }),
        })
      },
    }
  }

  private listUserOverviewOperation(): AdminOperationDefinition<
    ListUserOverviewQuery,
    ListUserOverviewOutput
  > {
    return {
      name: "memory.admin.list-user-overview",
      description: "列出某 userId 下的娃娃与记忆空间",
      roles: META_ROLES,
      kind: "query",
      bindings: [{ transport: "http", method: "GET", path: "/memory/user-overview" }],
      input: listUserOverviewInputSchema,
      output: listUserOverviewOutputSchema,
      audit: (input) => ({
        userId: input.userId,
        includeDeleted: input.includeDeleted ?? null,
      }),
      execute: async (input) => {
        const includeDeleted = input.includeDeleted === "true"
        const [devices, spaces] = await Promise.all([
          this.listDevicesByUser(input.userId),
          this.ctx.memorySpace.listSpaces(input.userId, { includeDeleted }),
        ])
        return { userId: input.userId, devices, spaces }
      },
    }
  }

  private listFastOperation(): AdminOperationDefinition<ListFastQuery, ListFastOutput> {
    return {
      name: "memory.admin.list-fast",
      description: "按记忆空间分页列出 Fast 记忆（含未消费/已消费计数）",
      roles: CONTENT_ROLES,
      kind: "query",
      bindings: [{ transport: "http", method: "GET", path: "/memory/fast" }],
      input: listFastInputSchema,
      output: listFastOutputSchema,
      audit: (input) => ({
        memorySpaceId: input.memorySpaceId,
        limit: input.limit ?? null,
        pendingOnly: input.pendingOnly ?? null,
      }),
      execute: async (input) => {
        const scope = await this.requireScope(input.memorySpaceId)
        const before = fastCursorFrom(input)
        const listInput: ListFastInput = {
          scope,
          ...(input.limit === undefined ? {} : { limit: parseLimit(input.limit) }),
          ...(before === undefined ? {} : { before }),
          ...(input.pendingOnly === undefined ? {} : { pendingOnly: input.pendingOnly === "true" }),
        }
        const [page, counts] = await Promise.all([
          this.ctx.memoryFast.listBySpace(listInput),
          this.ctx.memoryFast.countBySpace(scope),
        ])
        return {
          items: page.items,
          // 末页省略游标；undefined 不是合法的 JSON 值，不能进入 admin 输出校验。
          ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
          total: counts.total,
          pending: counts.pending,
          consumed: counts.consumed,
        }
      },
    }
  }

  private getFastOperation(): AdminOperationDefinition<GetFastQuery, GetFastOutput> {
    return {
      name: "memory.admin.get-fast",
      description: "按 fastId 读取单条 Fast 记忆详情",
      roles: CONTENT_ROLES,
      kind: "query",
      bindings: [{ transport: "http", method: "GET", path: "/memory/fast-detail" }],
      input: getFastInputSchema,
      output: fastRecordSchema,
      audit: (input) => ({ memorySpaceId: input.memorySpaceId, fastId: input.fastId }),
      execute: async (input) => {
        const scope = await this.requireScope(input.memorySpaceId)
        const record = await this.ctx.memoryFast.getFast(scope, input.fastId)
        if (record === null) {
          throw invalidInput(`Fast 记录 '${input.fastId}' 不存在或不属于该记忆空间`)
        }
        return record
      },
    }
  }

  private listLongOperation(): AdminOperationDefinition<ListLongQuery, ListLongOutput> {
    return {
      name: "memory.admin.list-long",
      description: "按记忆空间分页列出 Long 记忆块（可过滤 domain/lifecycle）",
      roles: CONTENT_ROLES,
      kind: "query",
      bindings: [{ transport: "http", method: "GET", path: "/memory/long" }],
      input: listLongInputSchema,
      output: listLongOutputSchema,
      audit: (input) => ({
        memorySpaceId: input.memorySpaceId,
        limit: input.limit ?? null,
        domain: input.domain ?? null,
        lifecycle: input.lifecycle ?? null,
      }),
      execute: async (input) => {
        const scope = await this.requireScope(input.memorySpaceId)
        const domain = enumOrUndefined(input.domain, LONG_DOMAINS, "domain")
        const lifecycle = enumOrUndefined(input.lifecycle, LONG_LIFECYCLES, "lifecycle")
        const orderBy = enumOrUndefined(input.orderBy, LONG_ORDER_BYS, "orderBy")
        const before = longCursorFrom(input)
        const listInput: ListLongInput = {
          scope,
          ...(input.limit === undefined ? {} : { limit: parseLimit(input.limit) }),
          ...(domain === undefined ? {} : { domain }),
          ...(lifecycle === undefined ? {} : { lifecycle }),
          ...(orderBy === undefined ? {} : { orderBy }),
          ...(before === undefined ? {} : { before }),
        }
        const [page, total] = await Promise.all([
          this.ctx.memoryLong.listBySpace(listInput),
          this.ctx.memoryLong.countBlocks(scope, {
            ...(domain === undefined ? {} : { domain }),
            ...(lifecycle === undefined ? {} : { lifecycle }),
          }),
        ])
        return {
          items: page.items,
          ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
          total,
        }
      },
    }
  }

  private getLongOperation(): AdminOperationDefinition<GetLongQuery, GetLongOutput> {
    return {
      name: "memory.admin.get-long",
      description: "按 blockId 读取单条 Long 记忆块详情（含全部细节）",
      roles: CONTENT_ROLES,
      kind: "query",
      bindings: [{ transport: "http", method: "GET", path: "/memory/long-detail" }],
      input: getLongInputSchema,
      output: longBlockSchema,
      audit: (input) => ({ memorySpaceId: input.memorySpaceId, blockId: input.blockId }),
      execute: async (input) => {
        const scope = await this.requireScope(input.memorySpaceId)
        const block = await this.ctx.memoryLong.getBlock(scope, input.blockId)
        if (block === null) {
          throw invalidInput(`Long 记忆块 '${input.blockId}' 不存在或不属于该记忆空间`)
        }
        return block
      },
    }
  }

  private runDailyOperation(): AdminOperationDefinition<RunDailyQuery, RunDailyOutput> {
    return {
      name: "memory.admin.run-daily",
      description: "为指定记忆空间手动执行一次 Daily（无视 fast 待整合阈值，返回批次 ID）",
      roles: ["superadmin"],
      kind: "command",
      bindings: [{ transport: "http", method: "POST", path: "/memory/run-daily" }],
      input: runDailyInputSchema,
      output: runDailyOutputSchema,
      audit: (input) => ({ memorySpaceId: input.memorySpaceId }),
      execute: async (input) => {
        const scope = await this.requireScope(input.memorySpaceId)
        try {
          return await this.ctx.memoryDaily.startDaily(scope)
        } catch (error) {
          if (error instanceof DailyMemoryError && error.code === "conflict") {
            throw new AdminError("conflict", "该记忆空间已有 Daily 在运行")
          }
          throw error
        }
      },
    }
  }

  private getDailyStatusOperation(): AdminOperationDefinition<GetDailyStatusQuery, DailyStatusOutput> {
    return {
      name: "memory.admin.get-daily-status",
      description: "按 batchId 查询 Daily 批次进度（状态 + 已完成的阶段）",
      roles: CONTENT_ROLES,
      kind: "query",
      bindings: [{ transport: "http", method: "GET", path: "/memory/daily-status" }],
      input: getDailyStatusInputSchema,
      output: dailyStatusOutputSchema,
      audit: (input) => ({ batchId: input.batchId }),
      execute: async (input) => {
        const batch = await this.ctx.memoryDaily.getBatch(input.batchId)
        if (batch === null) {
          throw invalidInput(`Daily 批次 '${input.batchId}' 不存在`)
        }
        return {
          batchId: batch.batchId,
          memorySpaceId: batch.memorySpaceId,
          status: batch.status,
          checkpointStage: batch.checkpointStage,
          startedAt: batch.startedAt,
          committedAt: batch.committedAt,
          finishedAt: batch.finishedAt,
        }
      },
    }
  }

  /** 由 memorySpaceId 解析其 owner，构造下层 scope；空间不存在时报错。 */
  private async requireScope(
    memorySpaceId: string,
  ): Promise<{ readonly userId: string; readonly memorySpaceId: string }> {
    const space = await this.ctx.memorySpace.getSpace(memorySpaceId)
    if (space === null) {
      throw invalidInput(`记忆空间 '${memorySpaceId}' 不存在`)
    }
    return { userId: space.userId, memorySpaceId: space.memorySpaceId }
  }

  /**
   * 临时用户读取：按字典序分页列出空间表中已出现的 distinct userId。
   *
   * 关系协议没有 DISTINCT，这里用 keyset 扫描 + JS 去重。真正的用户读取应
   * 由专门的用户包提供，本实现仅用于运维冒烟，不追求严谨的用户语义。
   */
  private async listUsers(options: {
    readonly limit: number
    readonly before?: string
  }): Promise<UserPage> {
    const wanted = options.limit + 1
    const userIds: string[] = []
    let last: string | undefined = options.before
    while (userIds.length < wanted) {
      const result = await this.requireRelational().execute({
        type: "find",
        table: SPACES_TABLE,
        ...(last === undefined
          ? {}
          : { where: { type: "gt", field: "user_id", value: last } }),
        orderBy: [
          { field: "user_id", direction: "asc" },
          { field: "memory_space_id", direction: "asc" },
        ],
        limit: USER_SCAN_BATCH,
      })
      if (result.rows.length === 0) {
        break
      }
      let advanced = false
      for (const row of result.rows) {
        const userId = asString(row, "user_id")
        if (userId !== last) {
          userIds.push(userId)
          last = userId
          advanced = true
          if (userIds.length >= wanted) {
            break
          }
        }
      }
      // 理论上 `user_id > last` 保证每批都会推进；防御性退出避免死循环。
      if (!advanced) {
        break
      }
    }
    return {
      items: userIds.slice(0, options.limit).map((userId) => ({ userId })),
      // 没有下一页时省略字段，符合 API 的可选游标约定。
      ...(userIds.length > options.limit ? { nextCursor: userIds[options.limit - 1]! } : {}),
    }
  }

  /** 临时用户读取：列出某 userId 下的娃娃绑定，按绑定时间升序。 */
  private async listDevicesByUser(userId: string): Promise<readonly DeviceBinding[]> {
    const result = await this.requireRelational().execute({
      type: "find",
      table: DEVICES_TABLE,
      where: { type: "eq", field: "user_id", value: userId },
      orderBy: [{ field: "created_at", direction: "asc" }],
    })
    return result.rows.map(deviceFromRow)
  }

  private requireRelational(): RelationalAdapter {
    if (this.relational === undefined) {
      throw new AdminError("source-not-ready", "关系型存储实例尚未初始化")
    }
    return this.relational
  }
}

export default MemoryGoAdmin

// ---------------------------------------------------------------------------
// 模块级辅助
// ---------------------------------------------------------------------------

function invalidInput(message: string): AdminError {
  return new AdminError("invalid-input", message)
}

/** query 串中的 limit 转数字：1-100 的正整数。 */
function parseLimit(raw: string): number {
  if (!/^[1-9]\d*$/.test(raw)) {
    throw invalidInput("limit 必须是正整数")
  }
  const value = Number(raw)
  if (value > 100) {
    throw invalidInput("limit 必须在 1 到 100 之间")
  }
  return value
}

/** 校验枚举 query 参数；省略返回 undefined，非法值报错。 */
function enumOrUndefined<T extends string>(
  raw: string | undefined,
  allowed: readonly T[],
  name: string,
): T | undefined {
  if (raw === undefined) {
    return undefined
  }
  if (!allowed.includes(raw as T)) {
    throw invalidInput(`${name} 必须是 ${allowed.join(" / ")} 之一`)
  }
  return raw as T
}

/** Fast 分页游标：beforeCreatedAt 与 beforeFastId 必须成对出现。 */
function fastCursorFrom(input: ListFastQuery): FastCursor | undefined {
  const hasCreatedAt = input.beforeCreatedAt !== undefined
  const hasFastId = input.beforeFastId !== undefined
  if (hasCreatedAt !== hasFastId) {
    throw invalidInput("beforeCreatedAt 与 beforeFastId 必须同时提供")
  }
  return hasCreatedAt ? { createdAt: input.beforeCreatedAt!, fastId: input.beforeFastId! } : undefined
}

/** Long 分页游标：beforeSortAt 与 beforeBlockId 必须成对出现。 */
function longCursorFrom(input: ListLongQuery): LongBlockCursor | undefined {
  const hasSortAt = input.beforeSortAt !== undefined
  const hasBlockId = input.beforeBlockId !== undefined
  if (hasSortAt !== hasBlockId) {
    throw invalidInput("beforeSortAt 与 beforeBlockId 必须同时提供")
  }
  return hasSortAt ? { sortAt: input.beforeSortAt!, blockId: input.beforeBlockId! } : undefined
}

/** 娃娃绑定表行 → 公开绑定对象（不含 binding_id）。 */
function deviceFromRow(row: RelationalRecord): DeviceBinding {
  return {
    userId: asString(row, "user_id"),
    deviceId: asString(row, "device_id"),
    memorySpaceId: asString(row, "memory_space_id"),
    createdAt: asString(row, "created_at"),
  }
}

function asString(row: RelationalRecord, field: string): string {
  const value = row[field]
  if (typeof value !== "string") {
    throw new AdminError("schema-mismatch", `关系表字段 '${field}' 不是字符串`)
  }
  return value
}
