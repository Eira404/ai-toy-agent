import { randomUUID } from "node:crypto"
import type {
  CreateSessionInput,
  EventRecord,
  FinishSessionInput,
  SessionRecord,
  TurnHistory,
  TurnRecord,
} from "toy-session-storage"
import { SessionDataError } from "./error.js"
import {
  publishSessionDataChange,
  requireSessionPersistence,
  sessionPersistence,
} from "./internal.js"
import { KeyedLock } from "./lock.js"
import { readAcceptEvents, readAcceptSession, readAcceptTurn, readInstallHistory } from "./read.js"
import {
  nonEmpty,
  ownerKey,
  positiveInteger,
  snapshotPayload,
  timestamp,
  type MutableTurnHistory,
} from "./shared.js"
import type { SessionData } from "./service.js"
import type { AppendEventInput, SessionHistory, WaitForWritesOptions } from "./types.js"

interface AgentEntry {
  session: SessionRecord
  turns: MutableTurnHistory[]
  turnById: Map<string, MutableTurnHistory>
  nextSequence: number
  nextTurnNo: number
}

/** Agent 运行数据对象：持有仍在运行的完整 Session 历史并协调两份内存更新。 */
export class AgentSessionData {
  private readonly sessions = new Map<string, AgentEntry>()
  private readonly activeByOwner = new Map<string, string>()
  private readonly locks = new KeyedLock()

  constructor(private readonly root: SessionData) {}

  /**
   * 创建 Session；数据库模式在同步落库成功后才写入两份内存并返回 ID。
   *
   * @param input 用户、设备、初始 payload 和格式版本。
   * @returns 已创建的 active Session。
   */
  createSession(input: CreateSessionInput): Promise<SessionRecord> {
    nonEmpty(input.userId, "userId")
    nonEmpty(input.deviceId, "deviceId")
    const payload = snapshotPayload(input.payload ?? {})
    const version = positiveInteger(input.version ?? 1, "version")
    const owner = ownerKey(input.userId, input.deviceId)
    return this.locks.with(`owner:${owner}`, async () => {
      if (this.activeByOwner.has(owner)) {
        throw new SessionDataError("active-session-exists", "该用户设备已有 active Session")
      }
      const storage = this.root[sessionPersistence]()
      const session: SessionRecord =
        storage === undefined
          ? {
              sessionId: randomUUID(),
              userId: input.userId,
              deviceId: input.deviceId,
              status: "active",
              payload,
              version,
              createdAt: new Date().toISOString(),
              closingAt: null,
              closedAt: null,
            }
          : await storage.createSession({ ...input, payload, version })
      this.installEmpty(session)
      this.root[publishSessionDataChange]({
        kind: "session-created",
        sessionId: session.sessionId,
        session,
      })
      return structuredClone(session)
    })
  }

  /**
   * 为当前 active Session 创建 Turn，并在两份内存中加入空 Event 列表。
   *
   * @param sessionId 所属 Session ID。
   * @returns 新 Turn；数据库模式此时已经落库。
   */
  createTurn(sessionId: string): Promise<TurnRecord> {
    nonEmpty(sessionId, "sessionId")
    return this.locks.with(`session:${sessionId}`, async () => {
      const entry = this.requireResident(sessionId)
      requireStatus(entry.session, "active")
      const storage = this.root[sessionPersistence]()
      const turn =
        storage === undefined
          ? {
              turnId: randomUUID(),
              sessionId,
              turnNo: entry.nextTurnNo,
              startedAt: new Date().toISOString(),
            }
          : await storage.createTurn(sessionId)
      if (!Number.isSafeInteger(turn.turnNo) || turn.turnNo < entry.nextTurnNo) {
        throw new SessionDataError("invalid-state", "Turn 顺序与 Agent 运行历史不一致")
      }
      const history: MutableTurnHistory = { turn, events: [] }
      entry.turns.push(history)
      entry.turnById.set(turn.turnId, history)
      entry.nextTurnNo = turn.turnNo + 1
      this.root.read[readAcceptTurn](turn)
      this.root[publishSessionDataChange]({ kind: "turn-created", sessionId, turn })
      return structuredClone(turn)
    })
  }

  /**
   * 分配 Event ID 和 Session 内 sequence，确认队列接收后更新两份内存。
   *
   * @param sessionId 目标 active Session ID。
   * @param turnId Event 所属 Turn ID。
   * @param inputs 待追加的 Event 内容，输入顺序就是 sequence 顺序。
   * @returns 完整 Event 记录；数据库模式此时仅保证入队。
   */
  appendEvents(
    sessionId: string,
    turnId: string,
    inputs: readonly AppendEventInput[],
  ): Promise<readonly EventRecord[]> {
    nonEmpty(sessionId, "sessionId")
    nonEmpty(turnId, "turnId")
    if (inputs.length === 0) {
      return Promise.resolve([])
    }
    return this.locks.with(`session:${sessionId}`, async () => {
      const entry = this.requireResident(sessionId)
      requireStatus(entry.session, "active")
      const turn = this.requireTurn(entry, turnId)
      if (entry.nextSequence + inputs.length - 1 > Number.MAX_SAFE_INTEGER) {
        throw new SessionDataError("invalid-state", "Session sequence 已达到安全整数上限")
      }
      const events = inputs.map((input, index): EventRecord => {
        nonEmpty(input.eventType, "eventType")
        const occurredAt = input.occurredAt ?? new Date().toISOString()
        timestamp(occurredAt, "occurredAt")
        return {
          eventId: randomUUID(),
          sessionId,
          turnId,
          sequence: entry.nextSequence + index,
          eventType: input.eventType,
          payload: snapshotPayload(input.payload),
          version: positiveInteger(input.version ?? 1, "version"),
          occurredAt,
        }
      })
      const storage = this.root[sessionPersistence]()
      if (storage !== undefined) {
        // 数据库模式先确认内存队列接收；失败时两份可读内存和 sequence 均不变。
        await storage.appendEvents(sessionId, turnId, events)
      }
      turn.events.push(...events)
      entry.nextSequence += events.length
      this.root.read[readAcceptEvents](sessionId, turnId, events)
      this.root[publishSessionDataChange]({ kind: "events-appended", sessionId, turnId, events })
      return structuredClone(events)
    })
  }

  /**
   * 记录上层决定的收尾开始；移除 active 设备索引但保留完整运行历史。
   *
   * @param sessionId 要进入 closing 的 Session ID。
   * @returns 已更新状态的 Session。
   */
  beginClosingSession(sessionId: string): Promise<SessionRecord> {
    nonEmpty(sessionId, "sessionId")
    return this.locks.with(`session:${sessionId}`, async () => {
      const entry = this.requireResident(sessionId)
      requireStatus(entry.session, "active")
      const storage = this.root[sessionPersistence]()
      const session: SessionRecord =
        storage === undefined
          ? { ...entry.session, status: "closing", closingAt: new Date().toISOString() }
          : await storage.beginClosingSession(sessionId)
      entry.session = session
      const owner = ownerKey(session.userId, session.deviceId)
      if (this.activeByOwner.get(owner) === sessionId) {
        this.activeByOwner.delete(owner)
      }
      this.root.read[readAcceptSession](session)
      this.root[publishSessionDataChange]({ kind: "session-closing", sessionId, session })
      return structuredClone(session)
    })
  }

  /**
   * 保存 Session 收尾 payload；数据库模式等待 Event 确认落库后释放 Agent 运行数据。
   *
   * @param sessionId 要完成收尾的 Session ID。
   * @param input 最终 Session payload 和格式版本。
   * @param options 数据库模式下本次等待队列的超时和取消选项。
   * @returns 已关闭的 Session；无数据库时完整历史仍保留在端侧读取存储。
   */
  finishClosingSession(
    sessionId: string,
    input: FinishSessionInput,
    options: WaitForWritesOptions = {},
  ): Promise<SessionRecord> {
    nonEmpty(sessionId, "sessionId")
    const payload = snapshotPayload(input.payload)
    const version = positiveInteger(input.version, "version")
    return this.locks.with(`session:${sessionId}`, async () => {
      const entry = this.requireResident(sessionId)
      requireStatus(entry.session, "closing")
      const storage = this.root[sessionPersistence]()
      const session: SessionRecord =
        storage === undefined
          ? {
              ...entry.session,
              status: "closed",
              payload,
              version,
              closedAt: new Date().toISOString(),
            }
          : await storage.finishClosingSession(sessionId, { payload, version }, options)
      entry.session = session
      this.root.read[readAcceptSession](session)
      // 只释放 Agent 运行历史；读取存储按自身模式决定何时淘汰。
      this.sessions.delete(sessionId)
      this.root[publishSessionDataChange]({ kind: "session-closed", sessionId, session })
      return structuredClone(session)
    })
  }

  /**
   * @param sessionId 要等待写入的 Session ID。
   * @param options 等待超时与取消；不取消已入队任务。
   * @returns 数据库模式下当前队列任务提交后完成；内存模式立即完成。
   */
  waitForWrites(sessionId: string, options: WaitForWritesOptions = {}): Promise<void> {
    nonEmpty(sessionId, "sessionId")
    return (
      this.root[sessionPersistence]()?.waitForSessionWrites(sessionId, options) ?? Promise.resolve()
    )
  }

  /**
   * @param sessionId 目标 Session ID。
   * @returns 当前仍驻留的 Session；不从数据库隐式补读。
   */
  getSession(sessionId: string): SessionRecord | undefined {
    nonEmpty(sessionId, "sessionId")
    const session = this.sessions.get(sessionId)?.session
    return session === undefined ? undefined : structuredClone(session)
  }

  /**
   * @param userId 用户 ID。
   * @param deviceId 设备 ID。
   * @returns 当前驻留的 active Session；不存在时返回 undefined。
   */
  getActiveSession(userId: string, deviceId: string): SessionRecord | undefined {
    nonEmpty(userId, "userId")
    nonEmpty(deviceId, "deviceId")
    const id = this.activeByOwner.get(ownerKey(userId, deviceId))
    return id === undefined ? undefined : this.getSession(id)
  }

  /**
   * @param sessionId 要读取的驻留 Session ID。
   * @returns Session 及全部按 turnNo 排列的完整 Turn/Event 快照。
   */
  getHistory(sessionId: string): SessionHistory {
    const entry = this.requireResident(sessionId)
    return structuredClone({ session: entry.session, turns: entry.turns })
  }

  /**
   * @param sessionId 驻留 Session ID。
   * @param turnId 指定的 Turn ID。
   * @returns Turn 及其完整 Event 快照。
   */
  getTurn(sessionId: string, turnId: string): TurnHistory {
    const entry = this.requireResident(sessionId)
    return structuredClone(this.requireTurn(entry, turnId))
  }

  /**
   * @param sessionId 驻留 Session ID。
   * @param turnId 指定的 Turn ID。
   * @returns 该 Turn 内按 sequence 排列的全部 Event。
   */
  getTurnEvents(sessionId: string, turnId: string): readonly EventRecord[] {
    return this.getTurn(sessionId, turnId).events
  }

  /**
   * @param sessionId 驻留 Session ID。
   * @param turnIds 一个或多个 Turn ID。
   * @returns 按 turnNo 从早到晚排列的 Turn 及各自全部 Event。
   */
  getTurnsEvents(sessionId: string, turnIds: readonly string[]): readonly TurnHistory[] {
    const entry = this.requireResident(sessionId)
    if (new Set(turnIds).size !== turnIds.length) {
      throw new SessionDataError("invalid-input", "turnIds 不能重复")
    }
    const turns = turnIds.map((id) => this.requireTurn(entry, id))
    return structuredClone(turns.sort((left, right) => left.turn.turnNo - right.turn.turnNo))
  }

  /**
   * @param sessionId 驻留 Session ID。
   * @param beforeTurnId 当前 Turn ID，不包含当前 Turn。
   * @param count 要获取的最近几个更早 Turn。
   * @returns 按 turnNo 从早到晚排列的完整 Turn/Event 列表。
   */
  getPreviousTurnEvents(
    sessionId: string,
    beforeTurnId: string,
    count: number,
  ): readonly TurnHistory[] {
    const entry = this.requireResident(sessionId)
    const before = this.requireTurn(entry, beforeTurnId).turn.turnNo
    positiveInteger(count, "count")
    return structuredClone(entry.turns.filter(({ turn }) => turn.turnNo < before).slice(-count))
  }

  /**
   * 进程重启后显式恢复一个尚未关闭的 Session；Agent 普通读取不隐式访问数据库。
   *
   * @param sessionId 数据库中仍为 active 或 closing 的 Session ID。
   * @returns 恢复后的完整 Session 历史。
   */
  restoreSession(sessionId: string): Promise<SessionHistory> {
    nonEmpty(sessionId, "sessionId")
    return this.locks.with(`session:${sessionId}`, async () => {
      const existing = this.sessions.get(sessionId)
      if (existing !== undefined) {
        return this.getHistory(sessionId)
      }
      const storage = this.root[requireSessionPersistence]()
      const session = await storage.getSession(sessionId)
      if (session === undefined) {
        throw new SessionDataError("session-not-found", "Session 不存在")
      }
      if (session.status === "closed") {
        throw new SessionDataError("invalid-state", "已关闭 Session 不恢复到 Agent 运行存储")
      }
      const descending: TurnHistory[] = []
      let beforeTurnNo: number | undefined
      while (true) {
        const page = await storage.listTurnHistory({
          sessionId,
          limit: 100,
          ...(beforeTurnNo === undefined ? {} : { beforeTurnNo }),
        })
        descending.push(...page.items)
        if (page.nextCursor === undefined) {
          break
        }
        beforeTurnNo = page.nextCursor
      }
      const turns = descending.reverse().map((item): MutableTurnHistory => ({
        turn: item.turn,
        events: [...item.events],
      }))
      let latestSequence = 0
      for (const turn of turns) {
        for (const event of turn.events) {
          latestSequence = Math.max(latestSequence, event.sequence)
        }
      }
      const entry: AgentEntry = {
        session,
        turns,
        turnById: new Map(turns.map((item) => [item.turn.turnId, item])),
        nextTurnNo: (turns.at(-1)?.turn.turnNo ?? 0) + 1,
        nextSequence: latestSequence + 1,
      }
      this.sessions.set(sessionId, entry)
      if (session.status === "active") {
        this.activeByOwner.set(ownerKey(session.userId, session.deviceId), sessionId)
      }
      this.root.read[readInstallHistory]({ session, turns })
      return this.getHistory(sessionId)
    })
  }

  private installEmpty(session: SessionRecord): void {
    this.sessions.set(session.sessionId, {
      session,
      turns: [],
      turnById: new Map(),
      nextSequence: 1,
      nextTurnNo: 1,
    })
    this.activeByOwner.set(ownerKey(session.userId, session.deviceId), session.sessionId)
    this.root.read[readAcceptSession](session)
  }

  private requireResident(sessionId: string): AgentEntry {
    nonEmpty(sessionId, "sessionId")
    const entry = this.sessions.get(sessionId)
    if (entry === undefined) {
      throw new SessionDataError("not-resident", `Session '${sessionId}' 不在 Agent 运行存储中`)
    }
    return entry
  }

  private requireTurn(entry: AgentEntry, turnId: string): MutableTurnHistory {
    nonEmpty(turnId, "turnId")
    const turn = entry.turnById.get(turnId)
    if (turn === undefined) {
      throw new SessionDataError("turn-not-found", `Turn '${turnId}' 不属于该 Session`)
    }
    return turn
  }
}

function requireStatus(session: SessionRecord, status: SessionRecord["status"]): void {
  if (session.status !== status) {
    throw new SessionDataError("invalid-state", `Session 当前为 ${session.status}，要求 ${status}`)
  }
}
