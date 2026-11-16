import assert from "node:assert/strict"
import test from "node:test"
import { Context, Service } from "cordis"
import { DeviceError, DeviceService, gradeAge } from "../lib/index.js"

/** 假 debugDevices：只按 deviceId 返回记录，模拟 toy-debug-device 的 getDevice。 */
class FakeDebugDevices extends Service {
  constructor(ctx, records = new Map()) {
    super(ctx, "debugDevices")
    this.records = records
  }

  async getDevice(deviceId) {
    return this.records.get(deviceId)
  }
}

async function setup(records = new Map()) {
  const ctx = new Context()
  const fibers = []
  fibers.push(await ctx.plugin(FakeDebugDevices, records))
  fibers.push(await ctx.plugin(DeviceService))
  return {
    ctx,
    device: ctx.device,
    async dispose() {
      for (const fiber of fibers.reverse()) {
        await fiber.dispose()
      }
    },
  }
}

test("getDevicePresets 透传年龄与人设并给出年龄分级", async () => {
  const app = await setup(new Map([["d1", { deviceId: "d1", persona: "小恐龙蛋蛋", age: 5 }]]))
  try {
    const presets = await app.device.getDevicePresets("d1")
    assert.equal(presets.deviceId, "d1")
    assert.equal(presets.agePreset, 5)
    assert.equal(presets.ageGrade.id, "preschool")
    assert.equal(presets.ageGrade.label, "学龄前")
    assert.equal(presets.personaPreset, "小恐龙蛋蛋")
  } finally {
    await app.dispose()
  }
})

test("age/persona 为 null 时透传 null 且分级为 null", async () => {
  const app = await setup(new Map([["d2", { deviceId: "d2", age: null, persona: null }]]))
  try {
    const presets = await app.device.getDevicePresets("d2")
    assert.equal(presets.agePreset, null)
    assert.equal(presets.ageGrade, null)
    assert.equal(presets.personaPreset, null)
  } finally {
    await app.dispose()
  }
})

test("设备不存在时抛 device-not-found", async () => {
  const app = await setup(new Map())
  try {
    await assert.rejects(
      () => app.device.getDevicePresets("missing"),
      (error) => error instanceof DeviceError && error.code === "device-not-found",
    )
  } finally {
    await app.dispose()
  }
})

test("deviceId 为空时抛 invalid-input", async () => {
  const app = await setup(new Map())
  try {
    await assert.rejects(
      () => app.device.getDevicePresets("   "),
      (error) => error instanceof DeviceError && error.code === "invalid-input",
    )
  } finally {
    await app.dispose()
  }
})

test("gradeAge 覆盖各分级边界与 null", () => {
  assert.equal(gradeAge(null), null)
  assert.equal(gradeAge(0).id, "infant")
  assert.equal(gradeAge(3).id, "infant")
  assert.equal(gradeAge(4).id, "preschool")
  assert.equal(gradeAge(6).id, "preschool")
  assert.equal(gradeAge(7).id, "early-school")
  assert.equal(gradeAge(9).id, "early-school")
  assert.equal(gradeAge(10).id, "late-school")
  assert.equal(gradeAge(12).id, "late-school")
  assert.equal(gradeAge(13).id, "teen")
  assert.equal(gradeAge(17).id, "teen")
  assert.equal(gradeAge(18).id, "adult")
  assert.equal(gradeAge(150).id, "adult")
})
