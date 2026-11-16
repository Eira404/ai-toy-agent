/* global console */
import { Context } from "cordis"
import { FastWrite } from "toy-memory-write"
import { FakeLlm, FakeMemoryFast } from "../test/helpers.mjs"

const ctx = new Context()
const fibers = []
fibers.push(await ctx.plugin(FakeMemoryFast))
fibers.push(
  await ctx.plugin(FakeLlm, {
    responses: [
      {
        memories: [
          { title: "咖啡偏好", summary: "用户喜欢喝不加糖的冰美式", body: "- 用户喜欢喝不加糖的冰美式。" },
        ],
      },
      { memories: [] },
    ],
  }),
)
fibers.push(await ctx.plugin(FastWrite, { llmProvider: "fake", llmModel: "fake-model" }))

const scope = { userId: "u1", memorySpaceId: "space1" }

try {
  // 1. 提取并等待落库
  const extracted = await ctx.memoryWrite.extract({
    scope,
    sessionId: "s1",
    turnId: "t1",
    userMessage: "我喜欢喝不加糖的冰美式",
    recentConversation: [
      { role: "assistant", content: "你好" },
      { role: "user", content: "我喜欢喝不加糖的冰美式" },
    ],
  })
  console.log("extract(written):", extracted.kind, extracted.records?.map((record) => record.title))

  // 2. 直接写入，绕过 LLM
  const written = await ctx.memoryWrite.write({
    scope,
    sessionId: "s2",
    turnId: "t1",
    drafts: [{ title: "居住地", summary: "用户住在杭州", body: "- 用户住在杭州。" }],
  })
  console.log("write:", written.kind, written.records.map((record) => record.title))

  // 3. 启动即返回（后台继续）
  const started = await ctx.memoryWrite.extract(
    {
      scope,
      sessionId: "s3",
      turnId: "t1",
      userMessage: "随便聊聊",
      recentConversation: [],
    },
    "started",
  )
  console.log("extract(started):", started.kind)
  await new Promise((resolve) => setTimeout(resolve, 10))
} finally {
  for (const fiber of fibers.reverse()) {
    await fiber.dispose()
  }
}
