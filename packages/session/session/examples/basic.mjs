/* global console */
import { Context } from "cordis"
import { SessionData } from "toy-session-data"
import { ToySession } from "toy-session"

const ctx = new Context()
await ctx.plugin(SessionData)
await ctx.plugin(ToySession)
await ctx.plugin({
  name: "example-agent",
  inject: ["session"],
  apply(agentCtx) {
    agentCtx.effect(() =>
      agentCtx.session.registerTurnExecutor(
        async ({ message, config, history, turnCount, appendEvents, signal }) => {
          signal?.throwIfAborted()
          const messages = [...history, { role: "user", content: message.text }]
          console.log("本轮模型输入", { turnCount, messages, config })
          const text = `我收到了：${message.text}`
          await appendEvents([{ eventType: "assistant_message", payload: { text } }])
          return text
        },
      ),
    )
  },
})

// 用一个门闩暂停后处理，以便观察同一玩偶的新 Session 可以先开始。
let resumePostprocessing
const gate = new Promise((resolve) => {
  resumePostprocessing = resolve
})

try {
  ctx.session.preprocessing.register({
    name: "profile",
    process: ({ userId }) => ({ owner: userId, language: "zh" }),
  })
  ctx.session.postprocessing.register({
    name: "summary",
    async process({ turns }) {
      await gate
      return { turnCount: turns.length }
    },
  })

  const owner = { userId: "example-user", deviceId: "example-device" }
  const oldId = await ctx.session.createSession(owner)
  await ctx.session.runTurn(oldId, { message: { text: "你好" }, config: { thinking: false } })
  await ctx.session.runTurn(oldId, { message: { text: "我们刚才说了什么？" } })
  const closing = await ctx.session.requestClose(oldId)
  console.log("旧 Session 进入后台收尾", closing.status)

  const newId = await ctx.session.createSession(owner)
  await ctx.session.runTurn(newId, { message: { text: "开始新话题" } })

  resumePostprocessing()
  await ctx.session.waitForPostprocessing()
  console.log("旧 Session 已关闭", (await ctx.sessionData.read.getSession(oldId)).payload)
  await ctx.session.requestClose(newId)
} finally {
  resumePostprocessing()
  await ctx.session.waitForPostprocessing()
  await ctx.fiber.dispose()
}
