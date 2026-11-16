/* global console, Response */
import { Context } from "cordis"
import { LlmRuntime } from "toy-llm"
import { OpenAICompatiblePlugin } from "toy-llm-openai-compatible"

const ctx = new Context()
await ctx.plugin(LlmRuntime)
await ctx.plugin(OpenAICompatiblePlugin, {
  provider: "local-chat",
  baseURL: "https://provider.test/v1",
  // 模拟 Chat Completions 的 SSE 响应，便于无凭据运行示例。
  fetch: async () => {
    const chunk = { choices: [{ delta: { content: "你好！" }, finish_reason: "stop" }] }
    return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`)
  },
})
try {
  console.log(
    await ctx.llm.generate({
      provider: "local-chat",
      model: "demo",
      messages: [{ role: "user", content: [{ type: "text", text: "打个招呼" }] }],
    }),
  )
} finally {
  await ctx.fiber.dispose()
}
