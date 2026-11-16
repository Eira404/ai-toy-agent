import type {
  EventRecord,
  ListSessionsInput,
  ListTurnHistoryInput,
  Page,
  SessionCursor,
  SessionRecord,
  TurnHistory,
  TurnRecord,
} from "toy-session-storage"
import { SessionDataError } from "./error.js"
import { requireSessionPersistence, sessionPersistence } from "./internal.js"
import {
  beforeSession,
  compareSessions,
  nonEmpty,
  ownerKey,
  pageLimit,
  pageTurns,
  positiveInteger,
  timestamp,
  type MutableTurnHistory,
} from "./shared.js"
import type { SessionData } from "./service.js"
import type { SessionHistory } from "./types.js"

/** 包内同步两份内存的入口；Symbol 方法不作为包的公开 API 导出。 */
export const readAcceptSession = Symbol("read.acceptSession")
export const readAcceptTurn = Symbol("read.acceptTurn")
export const readAcceptEvents = Symbol("read.acceptEvents")
export const readInstallHistory = Symbol("read.installHistory")

interface FullSession {
  session: SessionRecord
  turns: MutableTurnHistory[]
  turnById: Map<string, MutableTurnHistory>
  lastUsed: number
}

interface CachedSessionPage {
  owner: string
  page: Page<SessionRecord, SessionCursor>
  lastUsed: number
}

interface CachedTurnPage {
  sessionId: string
  page: Page<TurnHistory, number>
  lastUsed: number
}

/** 端侧读取对象：内存模式保存全部历史，数据库模式缓存完整 Session 与历史页。 */
export class ReadSessionData {
  private readonly full = new Map<string, FullSession>()
  private readonly sessionIdsByOwner = new Map<string, string[]>()
  private readonly sessionPages = new Map<string, CachedSessionPage>()
  private readonly turnPages = new Map<string, CachedTurnPage>()
  private accessTick = 0

  constructor(
    private readonly root: SessionData,
    private readonly maxReadSessions: number,
    private readonly maxReadPages: number,
  ) {}

  /**
   * @param sessionId 要读取的 Session ID。
   * @returns 内存中的 Session 快照；缓存未命中时从数据库读取，不存在时返回 undefined。
   */
  async getSession(sessionId: string): Promise<SessionRecord | undefined> {
    nonEmpty(sessionId, "sessionId")
    const entry = this.full.get(sessionId)
    if (entry !== undefined) {
      this.touch(entry)
      return structuredClone(entry.session)
    }
    return this.root[sessionPersistence]()?.getSession(sessionId)
  }

  /**
   * @param userId 用户 ID。
   * @param deviceId 设备 ID。
   * @returns active Session；数据库模式在内存未命中时补读。
   */
  async getActiveSession(userId: string, deviceId: string): Promise<SessionRecord | undefined> {
    nonEmpty(userId, "userId")
    nonEmpty(deviceId, "deviceId")
    for (const sessionId of this.sessionIdsByOwner.get(ownerKey(userId, deviceId)) ?? []) {
      const entry = this.full.get(sessionId)
      if (entry?.session.status === "active") {
        this.touch(entry)
        return structuredClone(entry.session)
      }
    }
    return this.root[sessionPersistence]()?.getActiveSession(userId, deviceId)
  }

  /**
   * @param input 用户设备、页大小和可选游标。
   * @returns 按创建时间倒序排列的一页 Session；无数据库时从完整读取存储生成。
   */
  async listSessions(input: ListSessionsInput): Promise<Page<SessionRecord, SessionCursor>> {
    nonEmpty(input.userId, "userId")
    nonEmpty(input.deviceId, "deviceId")
    const limit = pageLimit(input.limit)
    if (input.before !== undefined) {
      nonEmpty(input.before.sessionId, "before.sessionId")
      timestamp(input.before.createdAt, "before.createdAt")
    }
    const owner = ownerKey(input.userId, input.deviceId)
    if (this.root.getMode() === "memory") {
      const sessions = (this.sessionIdsByOwner.get(owner) ?? [])
        .map((id) => this.full.get(id)?.session)
        .filter((session): session is SessionRecord => session !== undefined)
        .filter((session) => beforeSession(session, input.before))
        .sort(compareSessions)
        .slice(0, limit + 1)
      const visible = sessions.slice(0, limit)
      const last = visible.at(-1)
      return {
        items: structuredClone(visible),
        nextCursor:
          sessions.length > limit && last !== undefined
            ? { createdAt: last.createdAt, sessionId: last.sessionId }
            : undefined,
      }
    }
    const key = JSON.stringify([owner, input.before ?? null, limit])
    const cached = this.sessionPages.get(key)
    if (cached !== undefined) {
      cached.lastUsed = ++this.accessTick
      return structuredClone(cached.page)
    }
    const page = await this.root[requireSessionPersistence]().listSessions({ ...input, limit })
    this.sessionPages.set(key, { owner, page: structuredClone(page), lastUsed: ++this.accessTick })
    this.trimPages()
    return page
  }

  /**
   * @param sessionId Turn 所属 Session ID。
   * @param turnId 要读取的 Turn ID。
   * @returns Turn 与其全部 Event；历史缓存未命中时按 ID 从数据库补读。
   */
  async getTurnHistory(sessionId: string, turnId: string): Promise<TurnHistory> {
    nonEmpty(sessionId, "sessionId")
    nonEmpty(turnId, "turnId")
    const full = this.full.get(sessionId)
    if (full !== undefined) {
      const turn = full.turnById.get(turnId)
      if (turn === undefined) {
        throw new SessionDataError("turn-not-found", "Turn 不存在")
      }
      this.touch(full)
      return structuredClone(turn)
    }
    const storage = this.root[sessionPersistence]()
    if (storage === undefined) {
      throw new SessionDataError("session-not-found", "Session 不存在")
    }
    return storage.getTurnHistory(sessionId, turnId)
  }

  /**
   * @param sessionId 所属 Session ID。
   * @param turnIds 需要读取的一个或多个 Turn ID。
   * @returns 按 turnNo 从早到晚排列的完整 Turn；任一 ID 不存在则抛错。
   */
  async getTurnsHistory(
    sessionId: string,
    turnIds: readonly string[],
  ): Promise<readonly TurnHistory[]> {
    nonEmpty(sessionId, "sessionId")
    if (turnIds.length === 0) {
      return []
    }
    if (new Set(turnIds).size !== turnIds.length) {
      throw new SessionDataError("invalid-input", "turnIds 不能重复")
    }
    const full = this.full.get(sessionId)
    if (full !== undefined) {
      const turns = turnIds.map((id) => {
        const turn = full.turnById.get(id)
        if (turn === undefined) {
          throw new SessionDataError("turn-not-found", `Turn '${id}' 不存在`)
        }
        return turn
      })
      this.touch(full)
      return structuredClone(turns.sort((left, right) => left.turn.turnNo - right.turn.turnNo))
    }
    const storage = this.root[sessionPersistence]()
    if (storage === undefined) {
      throw new SessionDataError("session-not-found", "Session 不存在")
    }
    return storage.getTurnsHistory(sessionId, turnIds)
  }

  /**
   * @param input Session ID、页大小及更早 turnNo 游标。
   * @returns 一页完整 Turn；每个 Turn 的 Event 不被分页截断。
   */
  async listTurnHistory(input: ListTurnHistoryInput): Promise<Page<TurnHistory, number>> {
    nonEmpty(input.sessionId, "sessionId")
    const limit = pageLimit(input.limit)
    if (input.beforeTurnNo !== undefined) {
      positiveInteger(input.beforeTurnNo, "beforeTurnNo")
    }
    const full = this.full.get(input.sessionId)
    if (full !== undefined) {
      this.touch(full)
      return pageTurns(full.turns, input.beforeTurnNo, limit)
    }
    const storage = this.root[sessionPersistence]()
    if (storage === undefined) {
      throw new SessionDataError("session-not-found", "Session 不存在")
    }
    const key = JSON.stringify([input.sessionId, input.beforeTurnNo ?? null, limit])
    const cached = this.turnPages.get(key)
    if (cached !== undefined) {
      cached.lastUsed = ++this.accessTick
      return structuredClone(cached.page)
    }
    const page = await storage.listTurnHistory({ ...input, limit })
    this.turnPages.set(key, {
      sessionId: input.sessionId,
      page: structuredClone(page),
      lastUsed: ++this.accessTick,
    })
    this.trimPages()
    return page
  }

  /** Agent 创建或改变 Session 后同步更新端侧数据；旧列表页立即失效。 */
  [readAcceptSession](session: SessionRecord): void {
    let entry = this.full.get(session.sessionId)
    if (entry === undefined) {
      entry = { session, turns: [], turnById: new Map(), lastUsed: 0 }
      this.full.set(session.sessionId, entry)
      const owner = ownerKey(session.userId, session.deviceId)
      const ids = this.sessionIdsByOwner.get(owner) ?? []
      ids.push(session.sessionId)
      this.sessionIdsByOwner.set(owner, ids)
    } else {
      entry.session = session
    }
    this.touch(entry)
    const owner = ownerKey(session.userId, session.deviceId)
    for (const [key, page] of this.sessionPages) {
      if (page.owner === owner) {
        this.sessionPages.delete(key)
      }
    }
    this.trimFull()
  }

  /** Agent 创建 Turn 后同步更新端侧视图；分页边界变化使旧页失效。 */
  [readAcceptTurn](turn: TurnRecord): void {
    const entry = this.requireFull(turn.sessionId)
    const history: MutableTurnHistory = { turn, events: [] }
    entry.turns.push(history)
    entry.turnById.set(turn.turnId, history)
    this.touch(entry)
    for (const [key, page] of this.turnPages) {
      if (page.sessionId === turn.sessionId) {
        this.turnPages.delete(key)
      }
    }
  }

  /** Agent 追加 Event 后同步更新同一 Turn 的端侧视图。 */
  [readAcceptEvents](sessionId: string, turnId: string, events: readonly EventRecord[]): void {
    const entry = this.requireFull(sessionId)
    const turn = entry.turnById.get(turnId)
    if (turn === undefined) {
      throw new SessionDataError("turn-not-found", "读取存储缺少目标 Turn")
    }
    turn.events.push(...events)
    this.touch(entry)
  }

  /** 重启恢复时一次性装入活跃 Session 的完整 Turn/Event 历史。 */
  [readInstallHistory](history: SessionHistory): void {
    const turns = history.turns.map((item): MutableTurnHistory => ({
      turn: item.turn,
      events: [...item.events],
    }))
    const existing = this.full.get(history.session.sessionId)
    this.full.set(history.session.sessionId, {
      session: history.session,
      turns,
      turnById: new Map(turns.map((item) => [item.turn.turnId, item])),
      lastUsed: ++this.accessTick,
    })
    if (existing === undefined) {
      const owner = ownerKey(history.session.userId, history.session.deviceId)
      const ids = this.sessionIdsByOwner.get(owner) ?? []
      ids.push(history.session.sessionId)
      this.sessionIdsByOwner.set(owner, ids)
    }
    this.trimFull()
  }

  private requireFull(sessionId: string): FullSession {
    const entry = this.full.get(sessionId)
    if (entry === undefined) {
      throw new SessionDataError("not-resident", "读取存储缺少完整 Session")
    }
    return entry
  }

  private touch(entry: FullSession): void {
    entry.lastUsed = ++this.accessTick
  }

  /** 只淘汰已经 closed 且持久化完成的完整 Session；活跃数据允许超过上限。 */
  private trimFull(): void {
    if (this.root.getMode() === "memory") {
      return
    }
    const candidates = [...this.full.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed)
    for (const [sessionId, entry] of candidates) {
      if (this.full.size <= this.maxReadSessions) {
        break
      }
      if (entry.session.status === "closed") {
        this.full.delete(sessionId)
        const owner = ownerKey(entry.session.userId, entry.session.deviceId)
        const ids = this.sessionIdsByOwner.get(owner)
        if (ids !== undefined) {
          const remaining = ids.filter((id) => id !== sessionId)
          if (remaining.length === 0) {
            this.sessionIdsByOwner.delete(owner)
          } else {
            this.sessionIdsByOwner.set(owner, remaining)
          }
        }
      }
    }
  }

  private trimPages(): void {
    if (this.root.getMode() === "memory") {
      return
    }
    while (this.sessionPages.size + this.turnPages.size > this.maxReadPages) {
      let oldest: { kind: "session" | "turn"; key: string; lastUsed: number } | undefined
      for (const [key, page] of this.sessionPages) {
        if (oldest === undefined || page.lastUsed < oldest.lastUsed) {
          oldest = { kind: "session", key, lastUsed: page.lastUsed }
        }
      }
      for (const [key, page] of this.turnPages) {
        if (oldest === undefined || page.lastUsed < oldest.lastUsed) {
          oldest = { kind: "turn", key, lastUsed: page.lastUsed }
        }
      }
      if (oldest === undefined) {
        break
      }
      if (oldest.kind === "session") {
        this.sessionPages.delete(oldest.key)
      } else {
        this.turnPages.delete(oldest.key)
      }
    }
  }
}
