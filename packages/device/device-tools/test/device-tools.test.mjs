import assert from "node:assert/strict"
import test from "node:test"
import { Context } from "cordis"
import { DeviceTools } from "../lib/index.js"
import { ToolRegistry } from "toy-tools"

/** 直接解析一个工具快照并执行单个调用，避免拉起完整 Agent Loop。 */
function executeTool(ctx, name, args) {
  return ctx.tools
    .resolve({
      scope: { userId: "u1", deviceId: "d1", sessionId: "s1", turnId: "t1" },
      providerCapabilities: { functionTools: true },
    })
    .execute({ type: "tool-call", id: "c1", name, arguments: args })
}

test("默认 dry-run：命令不落真实设备，返回未配置标记", async () => {
  const ctx = new Context()
  await ctx.plugin(ToolRegistry)
  await ctx.plugin(DeviceTools)
  try {
    const result = await executeTool(ctx, "set_output_volume", JSON.stringify({ level: 30 }))
    assert.equal(result.isError, false)
    const parsed = JSON.parse(result.content)
    assert.equal(parsed.status, "DEVICE_TRANSPORT_NOT_CONFIGURED")
    assert.equal(parsed.deviceId, "d1")
    assert.equal(parsed.command, "set_output_volume")
  } finally {
    await ctx.fiber.dispose()
  }
})

test("提供 dispatch 时把命令交给装配方，返回值作为工具结果", async () => {
  const seen = []
  const ctx = new Context()
  await ctx.plugin(ToolRegistry)
  await ctx.plugin(DeviceTools, {
    async dispatch(command, context) {
      seen.push(command)
      return { ok: true, deviceId: context.deviceId }
    },
  })
  try {
    const result = await executeTool(ctx, "adjust_output_volume", JSON.stringify({ delta: -5 }))
    assert.equal(result.isError, false)
    assert.deepEqual(JSON.parse(result.content), { ok: true, deviceId: "d1" })
    assert.deepEqual(seen, [{ name: "adjust_output_volume", arguments: { delta: -5 } }])
  } finally {
    await ctx.fiber.dispose()
  }
})

test("参数越界或非法被 JSON Schema 拦截，不进入 dispatch", async () => {
  let dispatched = false
  const ctx = new Context()
  await ctx.plugin(ToolRegistry)
  await ctx.plugin(DeviceTools, {
    async dispatch() {
      dispatched = true
      return null
    },
  })
  try {
    const tooLoud = await executeTool(ctx, "set_output_volume", JSON.stringify({ level: 101 }))
    assert.equal(tooLoud.isError, true)
    assert.equal(dispatched, false)

    const zeroDelta = await executeTool(ctx, "adjust_output_volume", JSON.stringify({ delta: 0 }))
    assert.equal(zeroDelta.isError, true)
    assert.equal(dispatched, false)
  } finally {
    await ctx.fiber.dispose()
  }
})
