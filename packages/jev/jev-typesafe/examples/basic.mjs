/* global console, Response */
import { Context } from "cordis"
import { JevRuntime } from "toy-jev"
import { JevTypesafePlugin } from "toy-jev-typesafe"

const ctx = new Context()
await ctx.plugin(JevRuntime)
await ctx.plugin(JevTypesafePlugin, {
  baseURL: "https://provider.test",
  apiKey: "demo-key",
  fetch: async () =>
    Response.json({
      model: "demo",
      answers: { mood: { type: "noul", noul: 0.75 } },
    }),
})
try {
  console.log(
    await ctx.jev.invoke(
      "我今天很平静",
      {
        mood: { type: "noul", instructions: "评估平静程度" },
      },
      { model: "demo" },
    ),
  )
} finally {
  await ctx.fiber.dispose()
}
