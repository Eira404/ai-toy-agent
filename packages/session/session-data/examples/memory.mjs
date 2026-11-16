/* global console */
import { Context } from "cordis"
import { SessionData } from "../lib/index.js"

const ctx = new Context()
const fiber = await ctx.plugin(SessionData)
const unlisten = ctx.on("session-data/change", (change) => {
  console.log("SessionData 变化：", change.kind, change.sessionId)
})
try {
  console.log("存储模式：", ctx.sessionData.getMode()) // memory

  const session = await ctx.sessionData.agent.createSession({
    userId: "example-user",
    deviceId: "example-device",
  })
  const first = await ctx.sessionData.agent.createTurn(session.sessionId)
  await ctx.sessionData.agent.appendEvents(session.sessionId, first.turnId, [
    { eventType: "user_message", payload: { text: "你好" } },
    { eventType: "assistant_message", payload: { text: "你好！" } },
  ])
  const second = await ctx.sessionData.agent.createTurn(session.sessionId)
  await ctx.sessionData.agent.appendEvents(session.sessionId, second.turnId, [
    { eventType: "user_message", payload: { text: "再聊聊" } },
  ])

  console.log(
    "上一个 Turn：",
    ctx.sessionData.agent.getPreviousTurnEvents(session.sessionId, second.turnId, 1),
  )
  console.log(
    "端侧最新一页：",
    await ctx.sessionData.read.listTurnHistory({ sessionId: session.sessionId, limit: 1 }),
  )

  await ctx.sessionData.agent.beginClosingSession(session.sessionId)
  await ctx.sessionData.agent.finishClosingSession(session.sessionId, {
    payload: { summary: "示例结束" },
    version: 1,
  })
  // 关闭只释放 Agent 运行数据；无数据库时，端侧读取存储继续保留完整历史。
  console.log(
    "关闭后的历史：",
    await ctx.sessionData.read.getTurnHistory(session.sessionId, first.turnId),
  )
} finally {
  unlisten()
  await fiber.dispose()
}
