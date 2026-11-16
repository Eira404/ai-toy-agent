/* global setTimeout, structuredClone */
import assert from "node:assert/strict"
import test from "node:test"
import { Context, Service } from "cordis"
import { ToyStorage } from "toy-storage"
import { RelationalStorage } from "toy-storage-relational"
import { StorageWriteQueue } from "toy-storage-write-queue"
import { SessionStorage, sessionRelationalSchema } from "toy-session-storage"
import { SessionData, SessionDataError } from "../lib/index.js"

// 仅拦截 Event INSERT；Session/Turn 的同步写入仍按关系型接口执行。
class PausedRelational extends Service {
  static inject = ["storage"]

  constructor(ctx, config) {
    super(ctx, "pausedRelational")
    this.schema = sessionRelationalSchema
    this.rows = new Map(Object.keys(this.schema.tables).map((name) => [name, new Map()]))
    this.beforeEventInsert = config.beforeEventInsert
  }

  [Service.init]() {
    this.ctx.storage.register("relational", "main", this)
  }

  async execute(operation) {
    const table = this.rows.get(operation.table)
    const primaryKey = this.schema.tables[operation.table].primaryKey
    if (operation.type === "insert") {
      if (operation.table === "toy_session_events") {
        await this.beforeEventInsert()
      }
      const row = structuredClone(operation.value)
      if (table.has(row[primaryKey])) {
        throw new Error("duplicate key")
      }
      table.set(row[primaryKey], row)
      return { row: structuredClone(row) }
    }
    if (operation.type === "get") {
      return { row: structuredClone(table.get(operation.key)) }
    }
    if (operation.type === "update") {
      let affectedRows = 0
      for (const row of table.values()) {
        if (matches(row, operation.where)) {
          Object.assign(row, structuredClone(operation.patch))
          affectedRows++
        }
      }
      return { affectedRows }
    }
    if (operation.type === "find") {
      const rows = [...table.values()].filter(
        (row) => !operation.where || matches(row, operation.where),
      )
      for (const order of [...(operation.orderBy ?? [])].reverse()) {
        rows.sort(
          (left, right) =>
            (left[order.field] < right[order.field]
              ? -1
              : left[order.field] > right[order.field]
                ? 1
                : 0) * (order.direction === "desc" ? -1 : 1),
        )
      }
      return { rows: structuredClone(rows.slice(0, operation.limit ?? rows.length)) }
    }
    throw new Error(`测试数据库不支持 ${operation.type}`)
  }
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
      return filter.conditions.every((condition) => matches(row, condition))
    case "or":
      return filter.conditions.some((condition) => matches(row, condition))
    default:
      throw new Error(`测试数据库不支持条件 ${filter.type}`)
  }
}

function deferred() {
  let resolve
  const promise = new Promise((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function setup(gate) {
  const ctx = new Context()
  const fibers = []
  fibers.push(await ctx.plugin(ToyStorage))
  fibers.push(await ctx.plugin(RelationalStorage))
  fibers.push(await ctx.plugin(StorageWriteQueue))
  fibers.push(await ctx.plugin(PausedRelational, { beforeEventInsert: () => gate.promise }))
  fibers.push(await ctx.plugin(SessionStorage))
  fibers.push(await ctx.plugin(SessionData))
  return {
    ctx,
    rows: ctx.storage.get("relational", "main").rows,
    async dispose() {
      for (const fiber of fibers.reverse()) {
        await fiber.dispose()
      }
    },
  }
}

test("Event 入队后两份内存可读，waitForWrites 等待数据库确认后才返回", async () => {
  const gate = deferred()
  const app = await setup(gate)
  try {
    assert.equal(app.ctx.sessionData.getMode(), "persistent")
    const agent = app.ctx.sessionData.agent
    const read = app.ctx.sessionData.read
    const session = await agent.createSession({ userId: "u1", deviceId: "d1" })
    const turn = await agent.createTurn(session.sessionId)
    assert.ok(app.rows.get("toy_sessions").has(session.sessionId))
    assert.ok(app.rows.get("toy_session_turns").has(turn.turnId))

    const changes = []
    const unlisten = app.ctx.on("session-data/change", (change) => changes.push(change))
    const [event] = await agent.appendEvents(session.sessionId, turn.turnId, [
      { eventType: "user_message", payload: { text: "你好" } },
    ])
    unlisten()
    assert.equal(app.rows.get("toy_session_events").size, 0)
    assert.deepEqual(
      changes.map((change) => change.kind),
      ["events-appended"],
    )
    assert.deepEqual(changes[0].events, [event])
    assert.deepEqual(agent.getTurnEvents(session.sessionId, turn.turnId), [event])
    assert.deepEqual((await read.getTurnHistory(session.sessionId, turn.turnId)).events, [event])

    let confirmed = false
    const waiting = agent.waitForWrites(session.sessionId).then(() => {
      confirmed = true
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(confirmed, false)
    gate.resolve()
    await waiting
    assert.equal(confirmed, true)
    assert.ok(app.rows.get("toy_session_events").has(event.eventId))
    // 提交只让任务出队，不会清除 Agent 和端侧的可读 Event。
    assert.deepEqual(agent.getTurnEvents(session.sessionId, turn.turnId), [event])
    assert.deepEqual((await read.getTurnHistory(session.sessionId, turn.turnId)).events, [event])
  } finally {
    gate.resolve()
    await app.dispose()
  }
})

test("finishClosingSession 等待队列落库，然后才释放 Agent 运行历史", async () => {
  const gate = deferred()
  const app = await setup(gate)
  try {
    const agent = app.ctx.sessionData.agent
    const read = app.ctx.sessionData.read
    const session = await agent.createSession({ userId: "u2", deviceId: "d2" })
    const turn = await agent.createTurn(session.sessionId)
    const [event] = await agent.appendEvents(session.sessionId, turn.turnId, [
      { eventType: "assistant_message", payload: { text: "再见" } },
    ])
    await agent.beginClosingSession(session.sessionId)

    let closed = false
    const finishing = agent
      .finishClosingSession(session.sessionId, { payload: { summary: "完成" }, version: 1 })
      .then(() => {
        closed = true
      })
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(closed, false)
    assert.equal(agent.getSession(session.sessionId).status, "closing")
    assert.equal((await read.getSession(session.sessionId)).status, "closing")
    assert.equal(app.rows.get("toy_session_events").size, 0)

    gate.resolve()
    await finishing
    assert.equal(closed, true)
    assert.ok(app.rows.get("toy_session_events").has(event.eventId))
    assert.equal(app.rows.get("toy_sessions").get(session.sessionId).status, "closed")
    assert.throws(
      () => agent.getHistory(session.sessionId),
      (error) => error instanceof SessionDataError && error.code === "not-resident",
    )
    assert.deepEqual((await read.getTurnHistory(session.sessionId, turn.turnId)).events, [event])
  } finally {
    gate.resolve()
    await app.dispose()
  }
})
