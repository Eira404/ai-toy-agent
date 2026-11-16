/* global setTimeout, structuredClone */
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import test from "node:test"
import { Context, Service } from "cordis"
import { ToyStorage } from "toy-storage"
import { RelationalStorage } from "toy-storage-relational"
import { StorageWriteQueue } from "toy-storage-write-queue"
import { SessionStorage, SessionStorageError, sessionRelationalSchema } from "../lib/index.js"

class FakeRelational extends Service {
  static inject = ["storage"]

  constructor(ctx, config) {
    super(ctx, "fakeRelational")
    this.schema = config.schema ?? sessionRelationalSchema
    this.rows = new Map(Object.keys(this.schema.tables).map((name) => [name, new Map()]))
    this.beforeEventInsert = config.beforeEventInsert
  }

  [Service.init]() {
    this.ctx.storage.register("relational", "main", this)
  }

  async execute(operation) {
    const table = this.rows.get(operation.table)
    const primary = this.schema.tables[operation.table].primaryKey
    if (operation.type === "insert") {
      if (operation.table === "toy_session_events") {
        await this.beforeEventInsert?.()
      }
      const row = structuredClone(operation.value)
      if (table.has(row[primary])) {
        throw new Error("duplicate key")
      }
      table.set(row[primary], row)
      return { row: structuredClone(row) }
    }
    if (operation.type === "get") {
      return { row: structuredClone(table.get(operation.key)) }
    }
    if (operation.type === "update") {
      let affectedRows = 0
      for (const row of table.values()) {
        if (!matches(row, operation.where)) {
          continue
        }
        Object.assign(row, structuredClone(operation.patch))
        affectedRows++
      }
      return { affectedRows }
    }
    if (operation.type === "find") {
      const rows = [...table.values()].filter(
        (row) => !operation.where || matches(row, operation.where),
      )
      for (const order of [...(operation.orderBy ?? [])].reverse()) {
        rows.sort(
          (a, b) => compare(a[order.field], b[order.field]) * (order.direction === "desc" ? -1 : 1),
        )
      }
      const start = operation.offset ?? 0
      return { rows: structuredClone(rows.slice(start, start + (operation.limit ?? rows.length))) }
    }
    throw new Error(`fake 不支持 ${operation.type}`)
  }
}

function compare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0
}

function matches(row, filter) {
  switch (filter.type) {
    case "eq":
      return row[filter.field] === filter.value
    case "lt":
      return row[filter.field] < filter.value
    case "in":
      return filter.values.includes(row[filter.field])
    case "and":
      return filter.conditions.every((item) => matches(row, item))
    case "or":
      return filter.conditions.some((item) => matches(row, item))
    default:
      throw new Error(`fake 不支持 ${filter.type}`)
  }
}

async function setup({ beforeEventInsert, schema } = {}) {
  const ctx = new Context()
  const fibers = []
  fibers.push(await ctx.plugin(ToyStorage))
  fibers.push(await ctx.plugin(RelationalStorage))
  fibers.push(await ctx.plugin(StorageWriteQueue))
  fibers.push(await ctx.plugin(FakeRelational, { beforeEventInsert, schema }))
  fibers.push(await ctx.plugin(SessionStorage))
  return {
    ctx,
    session: ctx.sessionStorage,
    database: ctx.storage.get("relational", "main"),
    async dispose() {
      for (const fiber of fibers.reverse()) {
        await fiber.dispose()
      }
    },
  }
}

function deferred() {
  let resolve
  const promise = new Promise((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function event(session, turn, sequence, eventType, payload) {
  return {
    eventId: randomUUID(),
    sessionId: session.sessionId,
    turnId: turn.turnId,
    sequence,
    eventType,
    payload,
    version: 1,
    occurredAt: new Date().toISOString(),
  }
}

test("只定义数据库操作：Session/Turn 同步落库，Event 由队列执行", async () => {
  const gate = deferred()
  const app = await setup({ beforeEventInsert: () => gate.promise })
  try {
    const first = await app.session.createSession({ userId: "u1", deviceId: "d1" })
    assert.ok(app.database.rows.get("toy_sessions").has(first.sessionId))
    const turn = await app.session.createTurn(first.sessionId)
    assert.ok(app.database.rows.get("toy_session_turns").has(turn.turnId))
    const events = [
      event(first, turn, 1, "user", { text: "你好" }),
      event(first, turn, 2, "assistant", { text: "你好！" }),
    ]
    const receipts = await app.session.appendEvents(first.sessionId, turn.turnId, events)
    assert.equal(receipts.length, 2)
    assert.equal(app.database.rows.get("toy_session_events").size, 0)
    // 此包不保存运行缓存，未落库的 Event 不会出现在数据库读取结果中。
    assert.equal(
      (await app.session.listTurnHistory({ sessionId: first.sessionId })).items[0].events.length,
      0,
    )
    await app.session.beginClosingSession(first.sessionId)
    const second = await app.session.createSession({ userId: "u1", deviceId: "d1" })
    assert.notEqual(second.sessionId, first.sessionId)
    let finished = false
    const closing = app.session
      .finishClosingSession(first.sessionId, { payload: { summary: "完成" }, version: 2 })
      .then(() => {
        finished = true
      })
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(finished, false)
    gate.resolve()
    await closing
    assert.equal(app.database.rows.get("toy_session_events").size, 2)
    const history = await app.session.listTurnHistory({ sessionId: first.sessionId })
    assert.deepEqual(
      history.items[0].events.map((item) => item.eventId),
      events.map((item) => item.eventId),
    )
    assert.equal((await app.session.getSession(first.sessionId)).status, "closed")
  } finally {
    gate.resolve()
    await app.dispose()
  }
})

test("按 Turn 分页返回完整 Event，设备 Session 列表按游标读取", async () => {
  const app = await setup()
  try {
    const first = await app.session.createSession({ userId: "u1", deviceId: "d1" })
    const turn1 = await app.session.createTurn(first.sessionId)
    await app.session.appendEvents(first.sessionId, turn1.turnId, [
      event(first, turn1, 1, "one", {}),
      event(first, turn1, 2, "two", {}),
    ])
    await app.session.waitForSessionWrites(first.sessionId)
    assert.equal((await app.session.getTurnHistory(first.sessionId, turn1.turnId)).events.length, 2)
    const turn2 = await app.session.createTurn(first.sessionId)
    await app.session.appendEvents(first.sessionId, turn2.turnId, [
      event(first, turn2, 3, "three", {}),
    ])
    await app.session.waitForSessionWrites(first.sessionId)
    assert.deepEqual(
      (await app.session.getTurnsHistory(first.sessionId, [turn2.turnId, turn1.turnId])).map(
        (item) => item.turn.turnId,
      ),
      [turn1.turnId, turn2.turnId],
    )
    const newest = await app.session.listTurnHistory({ sessionId: first.sessionId, limit: 1 })
    assert.equal(newest.items[0].turn.turnId, turn2.turnId)
    const older = await app.session.listTurnHistory({
      sessionId: first.sessionId,
      limit: 1,
      beforeTurnNo: newest.nextCursor,
    })
    assert.equal(older.items[0].events.length, 2)
    await app.session.beginClosingSession(first.sessionId)
    await app.session.finishClosingSession(first.sessionId, { payload: {}, version: 1 })
    const second = await app.session.createSession({ userId: "u1", deviceId: "d1" })
    const firstPage = await app.session.listSessions({ userId: "u1", deviceId: "d1", limit: 1 })
    const secondPage = await app.session.listSessions({
      userId: "u1",
      deviceId: "d1",
      limit: 1,
      before: firstPage.nextCursor,
    })
    assert.deepEqual(
      new Set([...firstPage.items, ...secondPage.items].map((item) => item.sessionId)),
      new Set([first.sessionId, second.sessionId]),
    )
  } finally {
    await app.dispose()
  }
})

test("拒绝重复 active Session 和不属于当前 Session 的 Turn", async () => {
  const app = await setup()
  try {
    const first = await app.session.createSession({ userId: "u1", deviceId: "d1" })
    const other = await app.session.createSession({ userId: "u2", deviceId: "d2" })
    const otherTurn = await app.session.createTurn(other.sessionId)
    await assert.rejects(
      () => app.session.createSession({ userId: "u1", deviceId: "d1" }),
      (error) => error instanceof SessionStorageError && error.code === "active-session-exists",
    )
    await assert.rejects(
      () =>
        app.session.appendEvents(first.sessionId, otherTurn.turnId, [
          event(first, otherTurn, 1, "x", {}),
        ]),
      (error) => error instanceof SessionStorageError && error.code === "turn-not-found",
    )
  } finally {
    await app.dispose()
  }
})
