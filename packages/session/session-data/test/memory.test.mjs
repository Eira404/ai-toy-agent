import assert from "node:assert/strict"
import test from "node:test"
import { Context } from "cordis"
import { SessionData, SessionDataError } from "../lib/index.js"

async function setup(config) {
  const ctx = new Context()
  const fiber = await ctx.plugin(SessionData, config)
  return {
    ctx,
    async dispose() {
      await fiber.dispose()
    },
  }
}

test("两份内存分别接收 Turn/Event，Agent 可按一个、多个和之前的 Turn 取完整 Event", async () => {
  const app = await setup({ maxReadSessions: 1, maxReadPages: 1 })
  try {
    assert.equal(app.ctx.sessionData.getMode(), "memory")
    const agent = app.ctx.sessionData.agent
    const read = app.ctx.sessionData.read
    const session = await agent.createSession({ userId: "u1", deviceId: "d1" })
    const first = await agent.createTurn(session.sessionId)
    const firstEvents = await agent.appendEvents(session.sessionId, first.turnId, [
      { eventType: "user", payload: { text: "你好" } },
      { eventType: "assistant", payload: { text: "你好！" } },
    ])
    const second = await agent.createTurn(session.sessionId)
    const secondEvents = await agent.appendEvents(session.sessionId, second.turnId, [
      { eventType: "user", payload: { text: "继续" } },
    ])
    assert.deepEqual(
      [...firstEvents, ...secondEvents].map((event) => event.sequence),
      [1, 2, 3],
    )
    assert.deepEqual(agent.getTurnEvents(session.sessionId, first.turnId), firstEvents)
    assert.deepEqual(
      agent
        .getTurnsEvents(session.sessionId, [second.turnId, first.turnId])
        .map((item) => item.turn.turnId),
      [first.turnId, second.turnId],
    )
    assert.deepEqual(
      agent.getPreviousTurnEvents(session.sessionId, second.turnId, 1)[0].events,
      firstEvents,
    )
    assert.equal((await read.getTurnHistory(session.sessionId, first.turnId)).events.length, 2)
    const firstPage = await read.listTurnHistory({ sessionId: session.sessionId, limit: 1 })
    assert.equal(firstPage.items[0].turn.turnId, second.turnId)
    const secondPage = await read.listTurnHistory({
      sessionId: session.sessionId,
      limit: 1,
      beforeTurnNo: firstPage.nextCursor,
    })
    assert.equal(secondPage.items[0].events.length, 2)
    // 对外返回快照，上层修改内容不能改变任一内部存储。
    firstEvents[0].payload.text = "外部修改"
    assert.equal(agent.getTurnEvents(session.sessionId, first.turnId)[0].payload.text, "你好")
    assert.equal(
      (await read.getTurnHistory(session.sessionId, first.turnId)).events[0].payload.text,
      "你好",
    )

    await agent.beginClosingSession(session.sessionId)
    const next = await agent.createSession({ userId: "u1", deviceId: "d1" })
    assert.equal(agent.getActiveSession("u1", "d1").sessionId, next.sessionId)
    await agent.finishClosingSession(session.sessionId, {
      payload: { summary: "完成" },
      version: 2,
    })
    assert.throws(
      () => agent.getHistory(session.sessionId),
      (error) => error instanceof SessionDataError && error.code === "not-resident",
    )
    // 无数据库时读取存储保留已关闭的完整历史，即使配置的软上限只有 1。
    assert.equal((await read.getSession(session.sessionId)).status, "closed")
    assert.equal((await read.getTurnHistory(session.sessionId, first.turnId)).events.length, 2)
    assert.deepEqual(
      new Set(
        (await read.listSessions({ userId: "u1", deviceId: "d1" })).items.map(
          (item) => item.sessionId,
        ),
      ),
      new Set([session.sessionId, next.sessionId]),
    )
  } finally {
    await app.dispose()
  }
})

test("错误的 Turn 和 payload 不会向两份内存追加 Event", async () => {
  const app = await setup()
  try {
    const agent = app.ctx.sessionData.agent
    const session = await agent.createSession({ userId: "u2", deviceId: "d2" })
    const turn = await agent.createTurn(session.sessionId)
    await assert.rejects(
      () => agent.appendEvents(session.sessionId, "missing", [{ eventType: "x", payload: {} }]),
      (error) => error instanceof SessionDataError && error.code === "turn-not-found",
    )
    await assert.rejects(
      () =>
        agent.appendEvents(session.sessionId, turn.turnId, [
          { eventType: "x", payload: new Date() },
        ]),
      (error) => error instanceof SessionDataError && error.code === "invalid-input",
    )
    assert.deepEqual(agent.getTurnEvents(session.sessionId, turn.turnId), [])
    assert.deepEqual(
      (await app.ctx.sessionData.read.getTurnHistory(session.sessionId, turn.turnId)).events,
      [],
    )
  } finally {
    await app.dispose()
  }
})
