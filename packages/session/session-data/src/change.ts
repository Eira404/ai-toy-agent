import type { EventRecord, SessionRecord, TurnRecord } from "toy-session-storage"

/** SessionData 已接收的数据变化；通知表示可读，不代表 Event 已落库。 */
export type SessionDataChange =
  | {
      readonly kind: "session-created" | "session-closing" | "session-closed"
      readonly sessionId: string
      readonly session: SessionRecord
    }
  | {
      readonly kind: "turn-created"
      readonly sessionId: string
      readonly turn: TurnRecord
    }
  | {
      readonly kind: "events-appended"
      readonly sessionId: string
      readonly turnId: string
      readonly events: readonly EventRecord[]
    }

declare module "cordis" {
  interface Events {
    /** 由 SessionData 在两份内存更新完成后发布；监听器不能改变写入结果。 */
    "session-data/change": (change: SessionDataChange) => void | Promise<void>
  }
}

/**
 * 生成与内部存储隔离、不可被监听器修改的通知快照。
 *
 * @param change 刚完成的 Session、Turn 或 Event 变化。
 * @returns 可安全交给多个 Cordis 监听器的只读快照。
 */
export function snapshotChange(change: SessionDataChange): SessionDataChange {
  const snapshot = structuredClone(change)
  freezeDeep(snapshot)
  return snapshot
}

function freezeDeep(value: unknown): void {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return
  }
  Object.freeze(value)
  for (const child of Object.values(value)) {
    freezeDeep(child)
  }
}
