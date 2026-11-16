/* global structuredClone, fetch */
import assert from "node:assert/strict"
import test from "node:test"
import { Context, Service } from "cordis"
import { ToyStorage } from "toy-storage"
import { RelationalStorage } from "toy-storage-relational"
import { HttpServer } from "toy-backend-http"
import { DebugUsers, usersRelationalSchema } from "toy-debug-user"
import { DebugDevices, devicesRelationalSchema } from "toy-debug-device"
import { DebugBackendService } from "../lib/index.js"

const debugSchema = {
  tables: { ...usersRelationalSchema.tables, ...devicesRelationalSchema.tables },
}

class FakeRelational extends Service {
  static inject = ["storage"]

  constructor(ctx, config) {
    super(ctx, "fakeRelational")
    this.schema = config.schema ?? debugSchema
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

async function makeBackend() {
  const ctx = new Context()
  await ctx.plugin(ToyStorage)
  await ctx.plugin(RelationalStorage)
  await ctx.plugin(FakeRelational, { schema: debugSchema })
  await ctx.plugin(DebugUsers)
  await ctx.plugin(DebugDevices)
  await ctx.plugin(HttpServer, { port: 0 })
  await ctx.plugin(DebugBackendService)
  await ctx.http.ready
  return ctx
}

async function postJson(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
  return { status: res.status, json: await res.json() }
}

test("HTTP 用户：ensureUser → getUser", async () => {
  const ctx = await makeBackend()
  const base = `http://127.0.0.1:${ctx.http.address().port}`
  try {
    const ensured = await postJson(`${base}/debug/ensureUser`, { userId: "u1", displayName: "Alice" })
    assert.equal(ensured.status, 200)
    assert.equal(ensured.json.data.created, true)

    const user = await (await fetch(`${base}/debug/getUser/u1`)).json()
    assert.equal(user.data.displayName, "Alice")
  } finally {
    await ctx.fiber.dispose()
  }
})

test("HTTP 设备：createDevice → listDevices?userId", async () => {
  const ctx = await makeBackend()
  const base = `http://127.0.0.1:${ctx.http.address().port}`
  try {
    await postJson(`${base}/debug/createDevice`, { deviceId: "d1", userId: "u1" })
    await postJson(`${base}/debug/createDevice`, { deviceId: "d2" })

    const devices = await (await fetch(`${base}/debug/listDevices?userId=u1`)).json()
    assert.deepEqual(
      devices.data.items.map((item) => item.deviceId),
      ["d1"],
    )
  } finally {
    await ctx.fiber.dispose()
  }
})
