/* global console */
import { Context } from "cordis"
import { ToolRegistry } from "toy-tools"

const ctx = new Context()
await ctx.plugin(ToolRegistry)
const unregister = ctx.tools.register({
  name: "sum",
  description: "将两个整数相加",
  parameters: {
    type: "object",
    required: ["a", "b"],
    properties: { a: { type: "integer" }, b: { type: "integer" } },
  },
  isAvailable: (_scope, payload) => payload.allowMath === true,
  execute: ({ a, b }) => ({ sum: a + b }),
})

try {
  const tools = ctx.tools.resolve({
    scope: { userId: "u", deviceId: "d", sessionId: "s", turnId: "t" },
    payload: { allowMath: true },
    providerCapabilities: { functionTools: true },
  })
  console.log("模型可见工具", tools.schemas)
  console.log(
    await tools.execute({
      type: "tool-call",
      id: "call-1",
      name: "sum",
      arguments: JSON.stringify({ a: 2, b: 3 }),
    }),
  )
} finally {
  unregister()
  await ctx.fiber.dispose()
}
