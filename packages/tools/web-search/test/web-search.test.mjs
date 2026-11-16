import assert from "node:assert/strict"
import test from "node:test"
import { Context } from "cordis"
import { ToolRegistry } from "toy-tools"
import { WebSearchTool } from "toy-web-search"

const scope = { userId: "u", deviceId: "d", sessionId: "s", turnId: "t" }

test("web_search 内置工具注册并随 resolve 注入", async (t) => {
  const ctx = new Context()
  await ctx.plugin(ToolRegistry)
  await ctx.plugin(WebSearchTool)
  t.after(() => ctx.fiber.dispose())

  const tools = ctx.tools.resolve({
    scope,
    payload: {},
    providerCapabilities: { functionTools: true, builtinTools: ["web_search"] },
  })
  assert.deepEqual(tools.schemas, [
    { kind: "builtin", name: "web_search", description: "获取实时网络信息" },
  ])

  // Provider 不支持时不会注入
  const denied = ctx.tools.resolve({
    scope,
    payload: {},
    providerCapabilities: { functionTools: true, builtinTools: [] },
  })
  assert.deepEqual(denied.schemas, [])
})
