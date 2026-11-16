/* global console */
import { Context } from "cordis"
import { EmbeddingAdapter, EmbeddingRuntime } from "toy-embedding"

class LocalEmbedding extends EmbeddingAdapter {
  async embed(request) {
    // 用文本长度构造一维向量，演示结果必须与输入顺序一一对应。
    return {
      vectors: request.texts.map((text) => [text.length]),
      modelId: "local",
      dimensions: 1,
    }
  }
}

const ctx = new Context()
await ctx.plugin(EmbeddingRuntime)
const unregister = ctx.embedding.registerAdapter("local", new LocalEmbedding())
try {
  console.log(
    await ctx.embedding.embed({ provider: "local", model: "demo", texts: ["你好", "世界"] }),
  )
} finally {
  unregister()
  await ctx.fiber.dispose()
}
