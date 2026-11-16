/* global console */
import { Context } from "cordis"
import { JevAdapter, JevRuntime } from "toy-jev"

class LocalEvaluator extends JevAdapter {
  async invoke() {
    return {
      model: "local",
      answers: {
        mood: { type: "choice", choice: "calm", confidence: 0.9, probabilities: { calm: 0.9 } },
      },
    }
  }
}

const ctx = new Context()
await ctx.plugin(JevRuntime)
const unregister = ctx.jev.registerAdapter("local", new LocalEvaluator())
try {
  console.log(
    await ctx.jev.invoke(
      "今天过得挺好",
      {
        mood: { type: "choice", instructions: "判断情绪", criteria: { calm: "平静", happy: "开心" } },
      },
      { model: "demo" },
    ),
  )
} finally {
  unregister()
  await ctx.fiber.dispose()
}
