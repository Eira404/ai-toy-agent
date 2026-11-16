import type { JsonValue } from "toy-storage-relational"

/** Session 当前所处的业务生命周期。closing 期间允许同一设备开启新 Session。 */
export type SessionStatus = "active" | "closing" | "closed"

/** Session 的身份、生命周期及收尾数据。version 表示 payload 的格式版本。 */
export interface SessionRecord {
  readonly sessionId: string
  readonly userId: string
  readonly deviceId: string
  readonly status: SessionStatus
  readonly payload: Exclude<JsonValue, null>
  readonly version: number
  readonly createdAt: string
  readonly closingAt: string | null
  readonly closedAt: string | null
}

/** 一个 Session 内的 Turn；turnNo 是该 Session 内单调递增的分页顺序。 */
export interface TurnRecord {
  readonly turnId: string
  readonly sessionId: string
  readonly turnNo: number
  readonly startedAt: string
}

/** Event 必须归属一个 Turn；sequence 是整个 Session 内的顺序。 */
export interface EventRecord {
  readonly eventId: string
  readonly sessionId: string
  readonly turnId: string
  readonly sequence: number
  readonly eventType: string
  readonly payload: Exclude<JsonValue, null>
  readonly version: number
  readonly occurredAt: string
}

/** 创建 Session 时由业务方确定的用户、设备及可选初始数据。 */
export interface CreateSessionInput {
  readonly userId: string
  readonly deviceId: string
  readonly payload?: Exclude<JsonValue, null>
  readonly version?: number
}

/** 完成收尾时写入 Session 本身的数据。 */
export interface FinishSessionInput {
  readonly payload: Exclude<JsonValue, null>
  readonly version: number
}

/** 按设备分页列出 Session 的游标。 */
export interface SessionCursor {
  readonly createdAt: string
  readonly sessionId: string
}

/** 一页 Session 列表的查询参数。 */
export interface ListSessionsInput {
  readonly userId: string
  readonly deviceId: string
  readonly limit?: number
  readonly before?: SessionCursor
}

/** 一个完整 Turn，附带属于它的所有 Event。 */
export interface TurnHistory {
  readonly turn: TurnRecord
  readonly events: readonly EventRecord[]
}

/** 按 Turn 而非 Event 数量分页的查询参数。 */
export interface ListTurnHistoryInput {
  readonly sessionId: string
  readonly limit?: number
  /** 只读取 turnNo 小于此值的 Turn；省略时从最新开始。 */
  readonly beforeTurnNo?: number
}

/** 通用分页结果；nextCursor 为 undefined 表示没有下一页。 */
export interface Page<T, Cursor> {
  readonly items: readonly T[]
  readonly nextCursor: Cursor | undefined
}

/** 插件初始化配置；关系型实例必须先注册，内存模式由其他插件承担。 */
export interface SessionStorageConfig {
  /** 已连接的关系型存储实例名称；默认 main。 */
  readonly sourceName?: string
}
