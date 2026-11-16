/* global console */
import { Context } from "cordis"
import { LlmAdapter, LlmRuntime } from "toy-llm"

class LocalModel extends LlmAdapter {
  async *stream() {
    yield { type: "text-delta", index: 0, text: "你好" }
    yield { type: "text-delta", index: 0, text: "，我是本地测试模型。" }
    yield { type: "finish", reason: { kind: "stop" } }
  }
}

const ctx = new Context()
await ctx.plugin(LlmRuntime)
const unregister = ctx.llm.registerAdapter("local", new LocalModel())
try {
  console.log(
    await ctx.llm.generate({
      provider: "local",
      model: "demo",
      messages: [{ role: "user", content: [{ type: "text", text: "你好" }] }],
    }),
  )
} finally {
  unregister()
  await ctx.fiber.dispose()
}
