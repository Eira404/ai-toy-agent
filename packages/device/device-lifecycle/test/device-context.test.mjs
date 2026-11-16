import assert from "node:assert/strict"
import test from "node:test"
import { Context, Service } from "cordis"
import { SessionData } from "toy-session-data"
import { ToySession } from "toy-session"
import { DeviceError } from "toy-device"
import {
  DeviceContext,
  devicePresetsToSnapshot,
  parseDevicePresets,
  renderDeviceSection,
  renderPersona,
} from "../lib/index.js"

const samplePresets = {
  deviceId: "d1",
  agePreset: 5,
  ageGrade: {
    id: "preschool",
    label: "学龄前",
    minAge: 4,
    maxAge: 6,
    description: "4–6 岁学龄前儿童：以具体形象思维为主，喜欢童话、绘本与游戏化的表达。",
  },
  personaPreset: "小恐龙",
}

/** 假 toy-device：按 deviceId 返回预设，或抛 DeviceError。 */
class FakeDevice extends Service {
  constructor(ctx, resolve = () => undefined) {
    super(ctx, "device")
    this.resolve = resolve
  }

  async getDevicePresets(deviceId) {
    return this.resolve(deviceId)
  }
}

/** 假 SystemPromptAssembler：只记录注册进来的片段。 */
class FakeSystemPrompt extends Service {
  constructor(ctx) {
    super(ctx, "systemPrompt")
    this.sections = []
  }

  registerSection(section) {
    this.sections.push(section)
    return () => {
      const index = this.sections.indexOf(section)
      if (index !== -1) {
        this.sections.splice(index, 1)
      }
    }
  }
}

async function setup(resolve) {
  const ctx = new Context()
  const fibers = []
  fibers.push(await ctx.plugin(SessionData))
  fibers.push(await ctx.plugin(ToySession))
  fibers.push(await ctx.plugin(FakeDevice, resolve))
  fibers.push(await ctx.plugin(FakeSystemPrompt))
  fibers.push(await ctx.plugin(DeviceContext))
  return {
    ctx,
    deviceContext: ctx.deviceContext,
    section: ctx.systemPrompt.sections.find((section) => section.name === "device-persona"),
    async dispose() {
      for (const fiber of fibers.reverse()) {
        await fiber.dispose()
      }
    },
  }
}

test("session 预处理把设备预设落进 payload", async () => {
  const app = await setup(async (id) => (id === "d1" ? samplePresets : undefined))
  try {
    const sessionId = await app.ctx.session.createSession({ userId: "u1", deviceId: "d1" })
    const session = app.ctx.sessionData.agent.getSession(sessionId)
    assert.deepEqual(session.payload.preprocessing["device-presets"], samplePresets)
  } finally {
    await app.dispose()
  }
})

test("设备不存在时存 null，不阻断会话创建", async () => {
  const app = await setup(async () => {
    throw new DeviceError("device-not-found", "设备不存在")
  })
  try {
    const sessionId = await app.ctx.session.createSession({ userId: "u1", deviceId: "missing" })
    const session = app.ctx.sessionData.agent.getSession(sessionId)
    assert.equal(session.payload.preprocessing["device-presets"], null)
  } finally {
    await app.dispose()
  }
})

test("SP 片段渲染人设与年龄段", async () => {
  const app = await setup(async (id) => (id === "d1" ? samplePresets : undefined))
  try {
    const sessionId = await app.ctx.session.createSession({ userId: "u1", deviceId: "d1" })
    const session = app.ctx.sessionData.agent.getSession(sessionId)
    const text = await app.section.render({ session })
    assert.match(text, /玩偶人设/)
    assert.match(text, /小恐龙/)
    assert.match(text, /面向年龄段/)
    assert.match(text, /学龄前/)
  } finally {
    await app.dispose()
  }
})

test("renderPersona 命中目录与原文兜底", () => {
  assert.match(renderPersona("小恐龙"), /小恐龙/)
  assert.match(renderPersona("自定义人设"), /自定义人设/)
  assert.equal(renderPersona(null), null)
  assert.equal(renderPersona("   "), null)
})

test("renderDeviceSection 对空/非法 payload 返回空串", () => {
  assert.equal(renderDeviceSection(null), "")
  assert.equal(renderDeviceSection({}), "")
  assert.equal(renderDeviceSection({ preprocessing: {} }), "")
})

test("devicePresetsToSnapshot 与 parseDevicePresets 往返", () => {
  const snapshot = devicePresetsToSnapshot(samplePresets)
  assert.deepEqual(
    parseDevicePresets({ preprocessing: { "device-presets": snapshot } }),
    samplePresets,
  )
  assert.equal(parseDevicePresets({}), null)
})
