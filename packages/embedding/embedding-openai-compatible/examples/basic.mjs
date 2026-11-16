/* global console, Response */
import { Context } from "cordis"
import { EmbeddingRuntime } from "toy-embedding"
import { EmbeddingOpenAICompatiblePlugin } from "toy-embedding-openai-compatible"

const ctx = new Context()
await ctx.plugin(EmbeddingRuntime)
await ctx.plugin(EmbeddingOpenAICompatiblePlugin, {
  provider: "local-embedding",
  baseURL: "https://provider.test/v1",
  // 模拟 /embeddings 响应，便于无凭据运行示例。
  fetch: async (_url, request) => {
    const { input } = JSON.parse(request.body)
    return new Response(
      JSON.stringify({
        data: input.map((text, index) => ({ index, embedding: [text.length] })),
        model: "demo",
      }),
    )
  },
})
try {
  console.log(
    await ctx.embedding.embed({
      provider: "local-embedding",
      model: "demo",
      texts: ["你好", "世界"],
    }),
  )
} finally {
  await ctx.fiber.dispose()
}
