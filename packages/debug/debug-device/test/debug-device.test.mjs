/* global structuredClone */
import assert from "node:assert/strict"
import test from "node:test"
import { Context, Service } from "cordis"
import { ToyStorage } from "toy-storage"
import { RelationalStorage } from "toy-storage-relational"
import { DebugDevices, DebugDeviceError, devicesRelationalSchema } from "../lib/index.js"

class FakeRelational extends Service {
  static inject = ["storage"]

  constructor(ctx, config) {
    super(ctx, "fakeRelational")
    this.schema = config.schema ?? devicesRelationalSchema
    this.rows = new Map(Object.keys(this.schema.tables).map((name) => [name, new Map()]))
  }

  [Service.init]() {
    this.ctx.storage.register("relational", "main", this)
  }

  async execute(operation) {
    const table = this.rows.get(operation.table)
    const primary = this.schema.tables[operation.table].primaryKey
    if (operation.type === "insert") {
      const row = structuredClone(operation.value)
      if (table.has(row[primary])) {
        throw new Error("duplicate key")
      }
      table.set(row[primary], row)
      return { row: structuredClone(row) }
    }
    if (operation.type === "get") {
      return { row: structuredClone(table.get(operation.key)) }
    }
    if (operation.type === "find") {
      const rows = [...table.values()].filter(
        (row) => !operation.where || matches(row, operation.where),
      )
      for (const order of [...(operation.orderBy ?? [])].reverse()) {
        rows.sort(
          (a, b) => compare(a[order.field], b[order.field]) * (order.direction === "desc" ? -1 : 1),
        )
      }
      const start = operation.offset ?? 0
      return { rows: structuredClone(rows.slice(start, start + (operation.limit ?? rows.length))) }
    }
    if (operation.type === "update") {
      let affectedRows = 0
      for (const row of table.values()) {
        if (!matches(row, operation.where)) {
          continue
        }
        Object.assign(row, structuredClone(operation.patch))
        affectedRows++
      }
      return { affectedRows }
    }
    if (operation.type === "delete") {
      let affectedRows = 0
      for (const [key, row] of [...table.entries()]) {
        if (!matches(row, operation.where)) {
          continue
        }
        table.delete(key)
        affectedRows++
      }
      return { affectedRows }
    }
    throw new Error(`fake 不支持 ${operation.type}`)
  }
}

function compare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0
}

function matches(row, filter) {
  switch (filter.type) {
    case "eq":
      return row[filter.field] === filter.value
    case "lt":
      return row[filter.field] < filter.value
    case "and":
      return filter.conditions.every((item) => matches(row, item))
    case "or":
      return filter.conditions.some((item) => matches(row, item))
    default:
      throw new Error(`fake 不支持 ${filter.type}`)
  }
}

async function setup() {
  const ctx = new Context()
  const fibers = []
  fibers.push(await ctx.plugin(ToyStorage))
  fibers.push(await ctx.plugin(RelationalStorage))
  fibers.push(await ctx.plugin(FakeRelational, { schema: devicesRelationalSchema }))
  fibers.push(await ctx.plugin(DebugDevices))
  return {
    ctx,
    devices: ctx.debugDevices,
    database: ctx.storage.get("relational", "main"),
    async dispose() {
      for (const fiber of fibers.reverse()) {
        await fiber.dispose()
      }
    },
  }
}

test("createDevice 记录人设与年龄，重复创建报 device-exists", async () => {
  const app = await setup()
  try {
    const d1 = await app.devices.createDevice({
      deviceId: "d1",
      userId: "u1",
      persona: "小恐龙蛋蛋",
      age: 5,
    })
    assert.equal(d1.userId, "u1")
    assert.equal(d1.persona, "小恐龙蛋蛋")
    assert.equal(d1.age, 5)
    assert.ok(app.database.rows.get("toy_devices").has("d1"))

    await assert.rejects(
      () => app.devices.createDevice({ deviceId: "d1" }),
      (error) => error instanceof DebugDeviceError && error.code === "device-exists",
    )
  } finally {
    await app.dispose()
  }
})

test("listDevices 可按 userId 过滤", async () => {
  const app = await setup()
  try {
    await app.devices.createDevice({ deviceId: "d1", userId: "u1" })
    await app.devices.createDevice({ deviceId: "d2" })
    await app.devices.createDevice({ deviceId: "d3", userId: "u1" })

    const u1Devices = await app.devices.listDevices({ userId: "u1" })
    assert.deepEqual(u1Devices.items.map((item) => item.deviceId).sort(), ["d1", "d3"])
  } finally {
    await app.dispose()
  }
})

test("updateDevice 解绑并清空人设与年龄，deleteDevice 删除", async () => {
  const app = await setup()
  try {
    await app.devices.ensureDevice({ deviceId: "d1", userId: "u1", persona: "小恐龙", age: 6 })
    const updated = await app.devices.updateDevice("d1", { userId: null, persona: null, age: null })
    assert.equal(updated.userId, null)
    assert.equal(updated.persona, null)
    assert.equal(updated.age, null)

    assert.equal(await app.devices.deleteDevice("d1"), true)
    assert.equal(await app.devices.getDevice("d1"), undefined)
    assert.equal(await app.devices.deleteDevice("d1"), false)
  } finally {
    await app.dispose()
  }
})

test("age 越界时拒绝创建", async () => {
  const app = await setup()
  try {
    await assert.rejects(
      () => app.devices.createDevice({ deviceId: "d1", age: -1 }),
      (error) => error instanceof DebugDeviceError && error.code === "invalid-input",
    )
    await assert.rejects(
      () => app.devices.createDevice({ deviceId: "d2", age: 151 }),
      (error) => error instanceof DebugDeviceError && error.code === "invalid-input",
    )
  } finally {
    await app.dispose()
  }
})
