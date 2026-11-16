import type { FastSearchResult, Scope } from "toy-memory-fast"
import type { LongSearchResult } from "toy-memory-long"

/**
 * `toy-memory-read` 的公共类型契约。
 *
 * read 只做编排，`fast` / `long` 直接透传下层结果，不重新组装——
 * 命中项里已天然携带 ID + 命中原因 + 分数，供 feedback 包登记召回。
 */

/** Long 检索模式；Fast 不区分强弱，模式只影响 Long。 */
export type ReadMode = "weak" | "strong"

/** 一次联合检索的输入。 */
export interface ReadSearchInput {
  readonly scope: Scope
  /** 主 Agent 生成的专用记忆检索 Query，read 不改写。 */
  readonly query: string
  /** 由主 Agent 指定的 Long 强弱模式。 */
  readonly mode: ReadMode
}

/** 整体检索状态（对应 v2 §9.6 三态）。 */
export type ReadStatus = "COMPLETE" | "PARTIAL" | "UNAVAILABLE"

/** 一次联合检索的结果：Fast 与 Long 两组完整结果 + 整体状态。 */
export interface ReadSearchResult {
  readonly status: ReadStatus
  readonly fast: FastSearchResult
  readonly long: LongSearchResult
}
