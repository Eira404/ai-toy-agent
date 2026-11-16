import { SessionDataError } from "./error.js"
import type {
  EventRecord,
  Page,
  SessionCursor,
  SessionRecord,
  TurnHistory,
} from "toy-session-storage"

/** 内部可追加的 Turn；对外读取时始终返回独立快照。 */
export interface MutableTurnHistory {
  readonly turn: TurnHistory["turn"]
  readonly events: EventRecord[]
}

export function ownerKey(userId: string, deviceId: string): string {
  return JSON.stringify([userId, deviceId])
}

export function nonEmpty(value: string, name: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new SessionDataError("invalid-input", `${name} 必须是非空字符串`)
  }
}

export function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new SessionDataError("invalid-input", `${name} 必须是正安全整数`)
  }
  return value
}

export function pageLimit(value: number | undefined): number {
  const limit = value ?? 10
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new SessionDataError("invalid-input", "limit 必须是 1 到 100 的安全整数")
  }
  return limit
}

export function timestamp(value: string, name: string): void {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new SessionDataError("invalid-input", `${name} 必须是有效时间字符串`)
  }
}

/** 拷贝并检查 JSON，防止上层在数据接收后修改 payload。 */
export function snapshotPayload(value: unknown): EventRecord["payload"] {
  if (value === null || !isJson(value, new WeakSet())) {
    throw new SessionDataError("invalid-input", "payload 必须是非 null 的普通 JSON 值")
  }
  return structuredClone(value)
}

function isJson(value: unknown, seen: WeakSet<object>): value is EventRecord["payload"] {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return true
  }
  if (typeof value === "number") {
    return Number.isFinite(value)
  }
  if (typeof value !== "object") {
    return false
  }
  if (seen.has(value)) {
    return false
  }
  seen.add(value)
  try {
    if (Array.isArray(value)) {
      return value.every((item) => isJson(item, seen))
    }
    const prototype = Object.getPrototypeOf(value) as object | null
    if (prototype !== Object.prototype && prototype !== null) {
      return false
    }
    return Object.values(value).every((item) => isJson(item, seen))
  } finally {
    seen.delete(value)
  }
}

export function compareSessions(left: SessionRecord, right: SessionRecord): number {
  return (
    right.createdAt.localeCompare(left.createdAt) || right.sessionId.localeCompare(left.sessionId)
  )
}

export function beforeSession(session: SessionRecord, cursor: SessionCursor | undefined): boolean {
  return (
    cursor === undefined ||
    session.createdAt < cursor.createdAt ||
    (session.createdAt === cursor.createdAt && session.sessionId < cursor.sessionId)
  )
}

/** 将完整 Turn 列表按 turnNo 倒序分页，Event 始终整组返回。 */
export function pageTurns(
  turns: readonly MutableTurnHistory[],
  beforeTurnNo: number | undefined,
  limit: number,
): Page<TurnHistory, number> {
  const selected = turns
    .filter(({ turn }) => beforeTurnNo === undefined || turn.turnNo < beforeTurnNo)
    .sort((left, right) => right.turn.turnNo - left.turn.turnNo)
    .slice(0, limit + 1)
  const visible = selected.slice(0, limit)
  return {
    items: structuredClone(visible),
    nextCursor: selected.length > limit ? visible.at(-1)?.turn.turnNo : undefined,
  }
}
