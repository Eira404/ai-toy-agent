/* global console, Response */
import { Context } from "cordis"
import { LlmRuntime } from "toy-llm"
import { OpenAIResponsesPlugin } from "toy-llm-openai-responses"

const ctx = new Context()
await ctx.plugin(LlmRuntime)
await ctx.plugin(OpenAIResponsesPlugin, {
  provider: "responses-demo",
  baseURL: "https://provider.test/v1",
  fetch: async () => {
    const chunk = {
      type: "response.completed",
      response: {
        output: [
          { id: "message", type: "message", content: [{ type: "output_text", text: "你好！" }] },
        ],
      },
    }
    return new Response(`data: ${JSON.stringify(chunk)}\n\n`)
  },
})
try {
  console.log(
    await ctx.llm.generate({
      provider: "responses-demo",
      model: "demo",
      reasoning: { enabled: true, effort: "low" },
      messages: [{ role: "user", content: [{ type: "text", text: "打个招呼" }] }],
    }),
  )
} finally {
  await ctx.fiber.dispose()
}
