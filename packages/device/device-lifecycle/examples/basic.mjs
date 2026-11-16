/* global console */
import { Context, Service } from "cordis"
import { SessionData } from "toy-session-data"
import { ToySession } from "toy-session"
import { DeviceError } from "toy-device"
import { DeviceContext } from "../lib/index.js"

/** 演示替身：按 deviceId 返回预设；不接真实 toy-device。 */
class FakeDevice extends Service {
  constructor(ctx) {
    super(ctx, "device")
  }

  async getDevicePresets(deviceId) {
    if (deviceId === "d1") {
      return {
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
    }
    throw new DeviceError("device-not-found", `设备 '${deviceId}' 不存在`)
  }
}

/** 演示替身：记录注册进来的 system prompt 片段。 */
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

const ctx = new Context()
const fibers = []
try {
  fibers.push(await ctx.plugin(SessionData))
  fibers.push(await ctx.plugin(ToySession))
  fibers.push(await ctx.plugin(FakeDevice))
  fibers.push(await ctx.plugin(FakeSystemPrompt))
  fibers.push(await ctx.plugin(DeviceContext))

  const d1 = await ctx.session.createSession({ userId: "u1", deviceId: "d1" })
  const missing = await ctx.session.createSession({ userId: "u1", deviceId: "missing" })

  const session = ctx.sessionData.agent.getSession(d1)
  console.log("d1 的 session 预设：", session.payload.preprocessing["device-presets"])
  console.log(
    "missing 的 session 预设：",
    ctx.sessionData.agent.getSession(missing).payload.preprocessing["device-presets"],
  )

  const section = ctx.systemPrompt.sections.find((item) => item.name === "device-persona")
  console.log(`\n渲染出的 system prompt 片段：\n${await section.render({ session })}`)
} finally {
  for (const fiber of fibers.reverse()) {
    await fiber.dispose()
  }
}
