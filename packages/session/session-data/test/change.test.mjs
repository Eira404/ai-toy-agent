import assert from "node:assert/strict"
import test from "node:test"
import { Context } from "cordis"
import { SessionData, SessionDataError } from "../lib/index.js"

async function setup() {
  const ctx = new Context()
  const fiber = await ctx.plugin(SessionData)
  return { ctx, dispose: () => fiber.dispose() }
}

test("五类变化在内存更新后发出，一批 Event 只通知一次", async () => {
  const app = await setup()
  const changes = []
  const unlisten = app.ctx.on("session-data/change", (change) => {
    changes.push(change)
    const agent = app.ctx.sessionData.agent
    if (change.kind === "session-created" || change.kind === "session-closing") {
      assert.equal(agent.getSession(change.sessionId).status, change.session.status)
    } else if (change.kind === "turn-created") {
      assert.equal(
        agent.getTurn(change.sessionId, change.turn.turnId).turn.turnId,
        change.turn.turnId,
      )
    } else if (change.kind === "events-appended") {
      assert.deepEqual(
        agent.getTurnEvents(change.sessionId, change.turnId).map((event) => event.eventId),
        change.events.map((event) => event.eventId),
      )
    } else {
      assert.equal(agent.getSession(change.sessionId), undefined)
    }
  })
  try {
    const agent = app.ctx.sessionData.agent
    const session = await agent.createSession({ userId: "u1", deviceId: "d1" })
    const turn = await agent.createTurn(session.sessionId)
    const events = await agent.appendEvents(session.sessionId, turn.turnId, [
      { eventType: "user", payload: { text: "你好" } },
      { eventType: "assistant", payload: { text: "你好！" } },
    ])
    await agent.waitForWrites(session.sessionId)
    await app.ctx.sessionData.read.getTurnHistory(session.sessionId, turn.turnId)
    await agent.beginClosingSession(session.sessionId)
    await agent.finishClosingSession(session.sessionId, { payload: {}, version: 1 })

    assert.deepEqual(
      changes.map((change) => change.kind),
      ["session-created", "turn-created", "events-appended", "session-closing", "session-closed"],
    )
    assert.deepEqual(changes[2].events, events)
    assert.deepEqual(
      changes[2].events.map((event) => event.sequence),
      [1, 2],
    )
    assert.throws(() => {
      changes[2].events[0].payload.text = "监听器修改"
    }, TypeError)
    assert.equal(
      (await app.ctx.sessionData.read.getTurnHistory(session.sessionId, turn.turnId)).events[0]
        .payload.text,
      "你好",
    )
  } finally {
    unlisten()
    await app.dispose()
  }
})

test("监听器失败不改变写入结果，其他监听器仍能收到变化", async () => {
  const app = await setup()
  try {
    const agent = app.ctx.sessionData.agent
    const session = await agent.createSession({ userId: "u2", deviceId: "d2" })
    const turn = await agent.createTurn(session.sessionId)
    const seen = []
    const stopFailure = app.ctx.on("session-data/change", () => {
      throw new Error("监听器故障")
    })
    const stopSuccess = app.ctx.on("session-data/change", (change) => {
      seen.push(change)
    })
    try {
      const events = await agent.appendEvents(session.sessionId, turn.turnId, [
        { eventType: "user", payload: { text: "成功写入" } },
      ])
      assert.deepEqual(
        seen.map((change) => change.kind),
        ["events-appended"],
      )
      assert.deepEqual(agent.getTurnEvents(session.sessionId, turn.turnId), events)
      assert.deepEqual(
        (await app.ctx.sessionData.read.getTurnHistory(session.sessionId, turn.turnId)).events,
        events,
      )
    } finally {
      stopSuccess()
      stopFailure()
    }
  } finally {
    await app.dispose()
  }
})

test("失败写入和只读操作不发变化通知", async () => {
  const app = await setup()
  try {
    const agent = app.ctx.sessionData.agent
    const session = await agent.createSession({ userId: "u3", deviceId: "d3" })
    const turn = await agent.createTurn(session.sessionId)
    const changes = []
    const unlisten = app.ctx.on("session-data/change", (change) => changes.push(change))
    try {
      await assert.rejects(
        () => agent.appendEvents(session.sessionId, "missing", [{ eventType: "x", payload: {} }]),
        (error) => error instanceof SessionDataError && error.code === "turn-not-found",
      )
      await agent.appendEvents(session.sessionId, turn.turnId, [])
      agent.getHistory(session.sessionId)
      await app.ctx.sessionData.read.listTurnHistory({ sessionId: session.sessionId })
      await agent.waitForWrites(session.sessionId)
      assert.deepEqual(changes, [])
    } finally {
      unlisten()
    }
  } finally {
    await app.dispose()
  }
})
