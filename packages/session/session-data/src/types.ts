import type { EventRecord, SessionRecord, TurnHistory } from "toy-session-storage"

/** 由数据插件分配 eventId 和 Session 内 sequence 的新 Event 内容。 */
export interface AppendEventInput {
  readonly eventType: string
  readonly payload: EventRecord["payload"]
  readonly version?: number
  readonly occurredAt?: string
}

/** Session 与按 turnNo 排列的完整 Turn 历史。 */
export interface SessionHistory {
  readonly session: SessionRecord
  readonly turns: readonly TurnHistory[]
}

/** 插件启动时选定的运行模式。 */
export type SessionDataMode = "memory" | "persistent"

/** 数据插件的软缓存上限；活跃 Session 不因上限而移除。 */
export interface SessionDataConfig {
  /** 有数据库时读取存储保留的完整 Session 数上限；默认 100。 */
  readonly maxReadSessions?: number
  /** 有数据库时缓存的分页结果数上限；默认 100。 */
  readonly maxReadPages?: number
}

/** 本次等待持久化的超时与取消；不取消已经进入写入队列的任务。 */
export interface WaitForWritesOptions {
  readonly timeoutMs?: number
  readonly signal?: AbortSignal
}
