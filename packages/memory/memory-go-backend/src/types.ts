/**
 * `toy-memory-go-backend` 的公共类型契约。
 *
 * 临时包：仅供 Go conversation 调用。context 由 Go 补齐并原样信任，
 * `memorySpaceId` 不在此列，由门面内部按 userId + deviceId 解析或创建。
 */

/** Go 补齐的最小调用上下文。 */
export interface MemoryContext {
  readonly userId: string
  readonly deviceId: string
  readonly sessionId: string
  readonly turnId: string
}

/** memory_read 的输入。 */
export interface ReadMemoryInput {
  readonly context: MemoryContext
  /** 专为记忆检索改写的查询句，非空。 */
  readonly query: string
  /** Long 强弱模式；省略默认 weak。 */
  readonly mode?: "weak" | "strong"
}

/** 读结果里精简后的 Fast 条目（只留正文，去掉内部 ID/分数）。 */
export interface ReadFastItem {
  readonly title: string
  readonly summary: string
  readonly body: string
}

/** 读结果里精简后的 Long 细节。 */
export interface ReadLongDetail {
  readonly summary: string
  readonly body: string
}

/** 读结果里精简后的 Long 记忆块。 */
export interface ReadLongItem {
  readonly title: string
  readonly summary: string
  readonly overviewBody: string
  readonly details: readonly ReadLongDetail[]
}

/** memory_read 的结果：整体状态 + Fast/Long 正文。 */
export interface ReadMemoryResult {
  readonly status: "COMPLETE" | "PARTIAL" | "UNAVAILABLE"
  readonly fast: readonly ReadFastItem[]
  readonly long: readonly ReadLongItem[]
}

/** 主模型生成的一条记忆草稿（title/summary/body）。 */
export interface MemoryDraft {
  readonly title: string
  readonly summary: string
  readonly body: string
}

/** memory_write 的输入。 */
export interface WriteMemoryInput {
  readonly context: MemoryContext
  /** 零到多条被明确要求保存的记忆；为空会被拒绝。 */
  readonly memories: readonly MemoryDraft[]
}

/** 落库后单条记录的投影（供 Go 核对内容与数量）。 */
export interface WriteMemoryRecord {
  readonly title: string
  readonly summary: string
  readonly body: string
}

/** memory_write 的结果。 */
export interface WriteMemoryResult {
  readonly kind: "written"
  readonly writeId: string
  readonly records: readonly WriteMemoryRecord[]
}
