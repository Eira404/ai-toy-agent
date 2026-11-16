import { randomUUID } from "node:crypto"
import { Service, type Context } from "cordis"
import "toy-storage"
import "toy-storage-relational"
import "toy-storage-write-queue"
import type {
  RelationalAdapter,
  RelationalFilter,
  RelationalOperation,
} from "toy-storage-relational"
import type { WriteReceipt, WriteWaitOptions } from "toy-storage-write-queue"
import { SessionStorageError } from "./error.js"
import { KeyedLock } from "./lock.js"
import {
  assertSessionSchema,
  eventFromRow,
  eventInsert,
  sessionFromRow,
  sessionRow,
  turnFromRow,
  turnRow,
} from "./relational.js"
import { sessionRelationalSchema } from "./schema.js"
import type {
  CreateSessionInput,
  EventRecord,
  FinishSessionInput,
  ListSessionsInput,
  ListTurnHistoryInput,
  Page,
  SessionCursor,
  SessionRecord,
  SessionStorageConfig,
  TurnHistory,
  TurnRecord,
} from "./types.js"

declare module "cordis" {
  interface Context {
    sessionStorage: SessionStorage
  }
}

/** Session 表定义与关系型操作的业务封装；不保存运行历史或读取缓存。 */
export class SessionStorage extends Service {
  static inject = ["storage", "storageRelational", "storageWriteQueue"]

  private readonly sourceName: string
  private readonly locks = new KeyedLock()
  private source: RelationalAdapter | undefined

  /**
   * @param ctx 已挂载命名存储、关系型协议和写入队列的 Cordis 上下文。
   * @param config 要使用的关系型存储实例名称。
   */
  constructor(ctx: Context, config: SessionStorageConfig = {}) {
    super(ctx, "sessionStorage")
    this.sourceName = config.sourceName ?? "main"
  }

  /** 核对 adapter 的表结构；关系型实例不存在时拒绝初始化。 */
  [Service.init](): void {
    const source = this.ctx.storage.tryGet<RelationalAdapter>("relational", this.sourceName)
    if (source === undefined) {
      throw new SessionStorageError(
        "source-not-ready",
        `关系型存储实例 'relational/${this.sourceName}' 尚未就绪`,
      )
    }
    assertSessionSchema(source)
    this.source = source
  }

  /**
   * 创建一个 active Session；数据库确认插入后才返回 ID。
   *
   * @param input 用户、设备及可选初始 payload 和格式版本。
   * @returns 已持久化的 Session。
   */
  createSession(input: CreateSessionInput): Promise<SessionRecord> {
    nonEmpty(input.userId, "userId")
    nonEmpty(input.deviceId, "deviceId")
    const version = positiveInteger(input.version ?? 1, "version")
    const identity = JSON.stringify([input.userId, input.deviceId])
    return this.locks.with(`identity:${identity}`, async () => {
      if ((await this.getActiveSession(input.userId, input.deviceId)) !== undefined) {
        throw new SessionStorageError("active-session-exists", "该用户和设备已有 active Session")
      }
      const session: SessionRecord = {
        sessionId: randomUUID(),
        userId: input.userId,
        deviceId: input.deviceId,
        status: "active",
        payload: snapshotPayload(input.payload ?? {}),
        version,
        createdAt: new Date().toISOString(),
        closingAt: null,
        closedAt: null,
      }
      const operation = {
        type: "insert",
        table: "toy_sessions",
        value: sessionRow(session),
      } as const
      this.assertOperation(operation)
      await this.requireSource().execute(operation)
      return structuredClone(session)
    })
  }

  /**
   * 为 active Session 创建 Turn。turnNo 由已落库的最新 Turn 决定。
   *
   * @param sessionId 所属 Session ID。
   * @returns 已持久化的 Turn，Event 此后可以引用其 ID。
   */
  createTurn(sessionId: string): Promise<TurnRecord> {
    nonEmpty(sessionId, "sessionId")
    return this.locks.with(`session:${sessionId}`, async () => {
      await this.requireSessionStatus(sessionId, "active")
      const result = await this.requireSource().execute({
        type: "find",
        table: "toy_session_turns",
        where: eq("session_id", sessionId),
        orderBy: [{ field: "turn_no", direction: "desc" }],
        limit: 1,
      })
      const latest = result.rows[0] === undefined ? 0 : turnFromRow(result.rows[0]).turnNo
      if (latest >= Number.MAX_SAFE_INTEGER) {
        throw new SessionStorageError("invalid-state", "Session turnNo 已达到安全整数上限")
      }
      const turn: TurnRecord = {
        turnId: randomUUID(),
        sessionId,
        turnNo: latest + 1,
        startedAt: new Date().toISOString(),
      }
      const operation = {
        type: "insert",
        table: "toy_session_turns",
        value: turnRow(turn),
      } as const
      this.assertOperation(operation)
      await this.requireSource().execute(operation)
      return structuredClone(turn)
    })
  }

  /**
   * 将上层已经分配好 ID、sequence 和 payload 的 Event 交给写入队列。
   * 本方法不维护内存历史，返回凭据也不代表已经落库。
   *
   * @param sessionId 所属 active Session ID。
   * @param turnId Event 所属且已落库的 Turn ID。
   * @param events 要写入的完整 Event，输入顺序就是该 Session 的队列顺序。
   * @returns 与 Event 一一对应的写入凭据；可用于等待确认。
   */
  appendEvents(
    sessionId: string,
    turnId: string,
    events: readonly EventRecord[],
  ): Promise<readonly WriteReceipt[]> {
    nonEmpty(sessionId, "sessionId")
    nonEmpty(turnId, "turnId")
    if (events.length === 0) {
      return Promise.resolve([])
    }
    return this.locks.with(`session:${sessionId}`, async () => {
      await this.requireSessionStatus(sessionId, "active")
      const turn = await this.requireSource().execute({
        type: "get",
        table: "toy_session_turns",
        key: turnId,
      })
      if (turn.row === undefined || turnFromRow(turn.row).sessionId !== sessionId) {
        throw new SessionStorageError("turn-not-found", `Turn '${turnId}' 不属于该 Session`)
      }
      const ids = new Set<string>()
      let previousSequence = 0
      for (const event of events) {
        if (event.sessionId !== sessionId || event.turnId !== turnId) {
          throw new SessionStorageError(
            "invalid-input",
            "Event 的 sessionId 或 turnId 与调用参数不一致",
          )
        }
        nonEmpty(event.eventId, "eventId")
        positiveInteger(event.sequence, "sequence")
        positiveInteger(event.version, "version")
        if (event.sequence <= previousSequence) {
          throw new SessionStorageError("invalid-input", "Event sequence 必须按输入顺序严格递增")
        }
        previousSequence = event.sequence
        if (ids.has(event.eventId)) {
          throw new SessionStorageError("invalid-input", "同一批 Event 不能重复使用 eventId")
        }
        ids.add(event.eventId)
        this.assertOperation(eventInsert(event))
      }
      // 队列先完整验证并复制批次；业务缓存由调用方单独维护。
      return this.ctx.storageWriteQueue.enqueueMany(
        events.map((event) => ({
          jobId: event.eventId,
          queueName: sessionQueueName(sessionId),
          target: { kind: "relational", name: this.sourceName },
          operation: eventInsert(event),
        })),
      )
    })
  }

  /**
   * 同步切换为 closing；提交后，同一用户设备可以创建新 active Session。
   *
   * @param sessionId 需要开始收尾的 Session ID。
   * @returns 状态已经持久化的 Session。
   */
  beginClosingSession(sessionId: string): Promise<SessionRecord> {
    nonEmpty(sessionId, "sessionId")
    return this.locks.with(`session:${sessionId}`, async () => {
      const closingAt = new Date().toISOString()
      const result = await this.requireSource().execute({
        type: "update",
        table: "toy_sessions",
        where: { type: "and", conditions: [eq("session_id", sessionId), eq("status", "active")] },
        patch: { status: "closing", closing_at: closingAt },
      })
      if (result.affectedRows !== 1) {
        await this.requireSessionStatus(sessionId, "active")
        throw new SessionStorageError("invalid-state", "Session 状态已改变")
      }
      return this.requireExistingSession(sessionId)
    })
  }

  /**
   * 等待该 Session 当前待写 Event 提交，再保存最终 Session payload 和 closed 状态。
   *
   * @param sessionId 要完成收尾的 Session ID。
   * @param input 收尾产生的 Session payload 与格式版本。
   * @param options 本次等待的超时或取消选项；不影响队列本身。
   * @returns 已持久化且状态为 closed 的 Session。
   */
  finishClosingSession(
    sessionId: string,
    input: FinishSessionInput,
    options: WriteWaitOptions = {},
  ): Promise<SessionRecord> {
    nonEmpty(sessionId, "sessionId")
    const version = positiveInteger(input.version, "version")
    return this.locks.with(`session:${sessionId}`, async () => {
      await this.requireSessionStatus(sessionId, "closing")
      const closedAt = new Date().toISOString()
      const patch = {
        status: "closed",
        payload: snapshotPayload(input.payload),
        version,
        closed_at: closedAt,
      } as const
      this.assertOperation({
        type: "update",
        table: "toy_sessions",
        where: eq("session_id", sessionId),
        patch,
      })
      await this.waitForSessionWrites(sessionId, options)
      const result = await this.requireSource().execute({
        type: "update",
        table: "toy_sessions",
        where: { type: "and", conditions: [eq("session_id", sessionId), eq("status", "closing")] },
        patch,
      })
      if (result.affectedRows !== 1) {
        throw new SessionStorageError("invalid-state", "Session 状态已改变")
      }
      return this.requireExistingSession(sessionId)
    })
  }

  /**
   * 等待当前已入队的该 Session 写操作全部确认提交。
   *
   * @param sessionId 目标 Session ID。
   * @param options 本次等待的超时或取消选项。
   * @returns 队列在调用时捕获到的任务提交后完成的 Promise。
   */
  waitForSessionWrites(sessionId: string, options: WriteWaitOptions = {}): Promise<void> {
    nonEmpty(sessionId, "sessionId")
    return this.ctx.storageWriteQueue.flush({ queueName: sessionQueueName(sessionId), ...options })
  }

  /**
   * 从关系型数据库读取 Session 元数据。
   *
   * @param sessionId 目标 Session ID。
   * @returns Session，不存在时返回 undefined。
   */
  async getSession(sessionId: string): Promise<SessionRecord | undefined> {
    nonEmpty(sessionId, "sessionId")
    const result = await this.requireSource().execute({
      type: "get",
      table: "toy_sessions",
      key: sessionId,
    })
    return result.row === undefined ? undefined : sessionFromRow(result.row)
  }

  /**
   * 查找用户设备当前的 active Session；closing 不参与匹配。
   *
   * @param userId 用户 ID。
   * @param deviceId 设备 ID。
   * @returns 找到的 Session，或 undefined。
   */
  async getActiveSession(userId: string, deviceId: string): Promise<SessionRecord | undefined> {
    nonEmpty(userId, "userId")
    nonEmpty(deviceId, "deviceId")
    const result = await this.requireSource().execute({
      type: "find",
      table: "toy_sessions",
      where: {
        type: "and",
        conditions: [eq("user_id", userId), eq("device_id", deviceId), eq("status", "active")],
      },
      limit: 1,
    })
    return result.rows[0] === undefined ? undefined : sessionFromRow(result.rows[0])
  }

  /**
   * 按创建时间倒序分页读取指定用户设备的 Session。
   *
   * @param input 用户、设备、页大小及上一页游标。
   * @returns 一页 Session 和可选的下一页游标。
   */
  async listSessions(input: ListSessionsInput): Promise<Page<SessionRecord, SessionCursor>> {
    nonEmpty(input.userId, "userId")
    nonEmpty(input.deviceId, "deviceId")
    const limit = pageLimit(input.limit)
    if (input.before !== undefined) {
      nonEmpty(input.before.sessionId, "before.sessionId")
      timestamp(input.before.createdAt, "before.createdAt")
    }
    const conditions: RelationalFilter[] = [
      eq("user_id", input.userId),
      eq("device_id", input.deviceId),
    ]
    if (input.before !== undefined) {
      conditions.push({
        type: "or",
        conditions: [
          { type: "lt", field: "created_at", value: input.before.createdAt },
          {
            type: "and",
            conditions: [
              eq("created_at", input.before.createdAt),
              { type: "lt", field: "session_id", value: input.before.sessionId },
            ],
          },
        ],
      })
    }
    const result = await this.requireSource().execute({
      type: "find",
      table: "toy_sessions",
      where: { type: "and", conditions },
      orderBy: [
        { field: "created_at", direction: "desc" },
        { field: "session_id", direction: "desc" },
      ],
      limit: limit + 1,
    })
    const sessions = result.rows.map(sessionFromRow)
    const visible = sessions.slice(0, limit)
    const last = visible.at(-1)
    return {
      items: visible,
      nextCursor:
        sessions.length > limit && last !== undefined
          ? { createdAt: last.createdAt, sessionId: last.sessionId }
          : undefined,
    }
  }

  /**
   * 按 ID 精确读取一个 Turn 及其全部已落库 Event。
   *
   * @param sessionId Turn 所属 Session ID。
   * @param turnId 要读取的 Turn ID。
   * @returns 完整 Turn 历史；Turn 不存在或不属于 Session 时抛错。
   */
  async getTurnHistory(sessionId: string, turnId: string): Promise<TurnHistory> {
    const histories = await this.getTurnsHistory(sessionId, [turnId])
    return histories[0]!
  }

  /**
   * 按 ID 批量读取 Turn 和各自全部 Event，按 turnNo 从早到晚返回。
   *
   * @param sessionId 所有 Turn 必须归属的 Session ID。
   * @param turnIds 要读取的 Turn ID 列表。
   * @returns 每个 Turn 及其按 sequence 排列的 Event；任一 ID 不存在时抛错。
   */
  async getTurnsHistory(
    sessionId: string,
    turnIds: readonly string[],
  ): Promise<readonly TurnHistory[]> {
    nonEmpty(sessionId, "sessionId")
    if (turnIds.length === 0) {
      return []
    }
    if (turnIds.length > 100 || new Set(turnIds).size !== turnIds.length) {
      throw new SessionStorageError("invalid-input", "turnIds 必须是至多 100 个不重复的 ID")
    }
    for (const turnId of turnIds) {
      nonEmpty(turnId, "turnId")
    }
    const turnResult = await this.requireSource().execute({
      type: "find",
      table: "toy_session_turns",
      where: {
        type: "and",
        conditions: [
          eq("session_id", sessionId),
          { type: "in", field: "turn_id", values: turnIds },
        ],
      },
      orderBy: [{ field: "turn_no", direction: "asc" }],
    })
    if (turnResult.rows.length !== turnIds.length) {
      throw new SessionStorageError("turn-not-found", "请求的 Turn 不存在或不属于该 Session")
    }
    const turns = turnResult.rows.map(turnFromRow)
    const eventResult = await this.requireSource().execute({
      type: "find",
      table: "toy_session_events",
      where: { type: "in", field: "turn_id", values: turnIds },
      orderBy: [{ field: "sequence", direction: "asc" }],
    })
    const byTurn = new Map<string, EventRecord[]>()
    for (const row of eventResult.rows) {
      const event = eventFromRow(row)
      const group = byTurn.get(event.turnId) ?? []
      group.push(event)
      byTurn.set(event.turnId, group)
    }
    return turns.map((turn) => ({ turn, events: byTurn.get(turn.turnId) ?? [] }))
  }

  /**
   * 按 Turn 分页读取历史；每个返回的 Turn 都包含它的全部 Event。
   *
   * @param input Session ID、页大小和可选的更早 turnNo 游标。
   * @returns 一页 Turn 与完整 Event 列表。
   */
  async listTurnHistory(input: ListTurnHistoryInput): Promise<Page<TurnHistory, number>> {
    nonEmpty(input.sessionId, "sessionId")
    const limit = pageLimit(input.limit)
    if (input.beforeTurnNo !== undefined) {
      positiveInteger(input.beforeTurnNo, "beforeTurnNo")
    }
    if ((await this.getSession(input.sessionId)) === undefined) {
      throw new SessionStorageError("session-not-found", "Session 不存在")
    }
    const conditions: RelationalFilter[] = [eq("session_id", input.sessionId)]
    if (input.beforeTurnNo !== undefined) {
      conditions.push({ type: "lt", field: "turn_no", value: input.beforeTurnNo })
    }
    const result = await this.requireSource().execute({
      type: "find",
      table: "toy_session_turns",
      where: { type: "and", conditions },
      orderBy: [{ field: "turn_no", direction: "desc" }],
      limit: limit + 1,
    })
    const turns = result.rows.slice(0, limit).map(turnFromRow)
    const ids = turns.map((turn) => turn.turnId)
    const eventResult =
      ids.length === 0
        ? { rows: [] }
        : await this.requireSource().execute({
            type: "find",
            table: "toy_session_events",
            where: { type: "in", field: "turn_id", values: ids },
            orderBy: [{ field: "sequence", direction: "asc" }],
          })
    const byTurn = new Map<string, EventRecord[]>()
    for (const row of eventResult.rows) {
      const event = eventFromRow(row)
      const group = byTurn.get(event.turnId) ?? []
      group.push(event)
      byTurn.set(event.turnId, group)
    }
    return {
      items: turns.map((turn) => ({ turn, events: byTurn.get(turn.turnId) ?? [] })),
      nextCursor: result.rows.length > limit ? turns.at(-1)?.turnNo : undefined,
    }
  }

  private async requireExistingSession(sessionId: string): Promise<SessionRecord> {
    const session = await this.getSession(sessionId)
    if (session === undefined) {
      throw new SessionStorageError("session-not-found", `Session '${sessionId}' 不存在`)
    }
    return session
  }

  private async requireSessionStatus(
    sessionId: string,
    expected: SessionRecord["status"],
  ): Promise<void> {
    const session = await this.requireExistingSession(sessionId)
    if (session.status !== expected) {
      throw new SessionStorageError(
        "invalid-state",
        `Session 当前为 ${session.status}，要求 ${expected}`,
      )
    }
  }

  private requireSource(): RelationalAdapter {
    if (this.source === undefined) {
      throw new SessionStorageError("source-not-ready", "关系型存储实例尚未初始化")
    }
    return this.source
  }

  private assertOperation(operation: RelationalOperation): void {
    this.ctx.storageRelational.assertOperation(sessionRelationalSchema, operation)
  }
}

function eq(field: string, value: string): RelationalFilter {
  return { type: "eq", field, value }
}

function nonEmpty(value: string, name: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new SessionStorageError("invalid-input", `${name} 必须是非空字符串`)
  }
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new SessionStorageError("invalid-input", `${name} 必须是正安全整数`)
  }
  return value
}

function timestamp(value: string, name: string): void {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new SessionStorageError("invalid-input", `${name} 必须是有效的时间字符串`)
  }
}

function pageLimit(value: number | undefined): number {
  const limit = value ?? 10
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new SessionStorageError("invalid-input", "limit 必须是 1 到 100 的安全整数")
  }
  return limit
}

function snapshotPayload(value: SessionRecord["payload"]): SessionRecord["payload"] {
  try {
    return structuredClone(value)
  } catch (error) {
    throw new SessionStorageError("invalid-input", "payload 必须是可复制的 JSON 数据", {
      cause: error,
    })
  }
}

function sessionQueueName(sessionId: string): string {
  return `session_${sessionId.replaceAll("-", "")}`
}

export default SessionStorage
