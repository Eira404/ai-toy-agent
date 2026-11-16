import type { FastCursor, FastRecord } from "toy-memory-fast"
import type { LongBlock, LongBlockCursor, LongBlockSummary } from "toy-memory-long"
import type { DeviceBinding, MemorySpace } from "toy-memory-space"

/**
 * `toy-memory-go-admin` 的公共类型契约。
 *
 * 这些能力通过 `toy-admin` 注册，走 GET + query 串绑定：`toy-admin-backend`
 * 只会把 query 串（字符串值）喂给 execute，所以输入类型如实声明为字符串，
 * execute 内再转成下层服务所需的数字/枚举/游标。
 */

// ─── 用户维度 ─────────────────────────────────────────────────────────────

/** `memory.admin.list-users` 的输入。 */
export interface ListUsersQuery {
  /** 每页条数，1-100，默认 20。 */
  readonly limit?: string
  /** 上一页最后一个 userId。 */
  readonly before?: string
}

/**
 * 一个去重后的 userId。
 *
 * 临时/测试语义：本后端没有真正的用户表，userId 只能从记忆空间表的
 * `user_id` 推导；真正的用户读取应由专门的用户包提供，本包不接。
 */
export interface UserSummary {
  readonly userId: string
}

/** `memory.admin.list-users` 的分页结果；`nextCursor` 为 undefined 表示没有下一页。 */
export interface UserPage {
  readonly items: readonly UserSummary[]
  readonly nextCursor?: string
}

export type ListUsersOutput = UserPage

/** `memory.admin.list-user-overview` 的输入。 */
export interface ListUserOverviewQuery {
  readonly userId: string
  /** "true" 时包含已软删除的空间。 */
  readonly includeDeleted?: string
}

/** `memory.admin.list-user-overview` 的结果：某用户下的娃娃与记忆空间。 */
export interface ListUserOverviewOutput {
  readonly userId: string
  readonly devices: readonly DeviceBinding[]
  readonly spaces: readonly MemorySpace[]
}

// ─── Fast 维度 ─────────────────────────────────────────────────────────────

/** `memory.admin.list-fast` 的输入。 */
export interface ListFastQuery {
  readonly memorySpaceId: string
  readonly limit?: string
  /** 与 beforeFastId 成对出现的游标时间。 */
  readonly beforeCreatedAt?: string
  /** 与 beforeCreatedAt 成对出现的游标主键。 */
  readonly beforeFastId?: string
  /** "true" 时只看未消费记录。 */
  readonly pendingOnly?: string
}

/** `memory.admin.list-fast` 的结果：分页记录 + 游标 + 计数。 */
export interface ListFastOutput {
  readonly items: readonly FastRecord[]
  readonly nextCursor?: FastCursor
  readonly total: number
  readonly pending: number
  readonly consumed: number
}

/** `memory.admin.get-fast` 的输入。 */
export interface GetFastQuery {
  readonly memorySpaceId: string
  readonly fastId: string
}

/** `memory.admin.get-fast` 的结果。 */
export type GetFastOutput = FastRecord

// ─── Long 维度 ─────────────────────────────────────────────────────────────

/** `memory.admin.list-long` 的输入。 */
export interface ListLongQuery {
  readonly memorySpaceId: string
  readonly limit?: string
  /** 与 beforeBlockId 成对出现的游标时间。 */
  readonly beforeSortAt?: string
  /** 与 beforeSortAt 成对出现的游标主键。 */
  readonly beforeBlockId?: string
  readonly domain?: string
  readonly lifecycle?: string
  readonly orderBy?: string
}

/** `memory.admin.list-long` 的结果：分页块摘要 + 游标 + 计数。 */
export interface ListLongOutput {
  readonly items: readonly LongBlockSummary[]
  readonly nextCursor?: LongBlockCursor
  readonly total: number
}

/** `memory.admin.get-long` 的输入。 */
export interface GetLongQuery {
  readonly memorySpaceId: string
  readonly blockId: string
}

/** `memory.admin.get-long` 的结果（含全部 details 与价值状态）。 */
export type GetLongOutput = LongBlock

/** `memory.admin.run-daily` 的输入。 */
export interface RunDailyQuery {
  readonly memorySpaceId: string
}

/** `memory.admin.run-daily` 的结果：异步触发的批次 ID。 */
export interface RunDailyOutput {
  readonly batchId: string
}

/** `memory.admin.get-daily-status` 的输入。 */
export interface GetDailyStatusQuery {
  readonly batchId: string
}

/** `memory.admin.get-daily-status` 的结果：Daily 批次进度。 */
export interface DailyStatusOutput {
  readonly batchId: string
  readonly memorySpaceId: string
  readonly status: string
  readonly checkpointStage: number
  readonly startedAt: string | null
  readonly committedAt: string | null
  readonly finishedAt: string | null
}
