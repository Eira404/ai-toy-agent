/* global structuredClone */
import assert from "node:assert/strict"
import test from "node:test"
import { Context, Service } from "cordis"
import { ToyStorage } from "toy-storage"
import { RelationalStorage } from "toy-storage-relational"
import { DebugUsers, DebugUserError, usersRelationalSchema } from "../lib/index.js"

class FakeRelational extends Service {
  static inject = ["storage"]

  constructor(ctx, config) {
    super(ctx, "fakeRelational")
    this.schema = config.schema ?? usersRelationalSchema
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
  fibers.push(await ctx.plugin(FakeRelational, { schema: usersRelationalSchema }))
  fibers.push(await ctx.plugin(DebugUsers))
  return {
    ctx,
    users: ctx.debugUsers,
    database: ctx.storage.get("relational", "main"),
    async dispose() {
      for (const fiber of fibers.reverse()) {
        await fiber.dispose()
      }
    },
  }
}

test("createUser 创建并读取，重复创建报 user-exists", async () => {
  const app = await setup()
  try {
    const user = await app.users.createUser({ userId: "u1", displayName: "Alice" })
    assert.equal(user.userId, "u1")
    assert.equal(user.displayName, "Alice")
    assert.equal(user.payload, null)
    assert.ok(app.database.rows.get("toy_users").has("u1"))

    const loaded = await app.users.getUser("u1")
    assert.equal(loaded.displayName, "Alice")

    await assert.rejects(
      () => app.users.createUser({ userId: "u1" }),
      (error) => error instanceof DebugUserError && error.code === "user-exists",
    )
  } finally {
    await app.dispose()
  }
})

test("ensureUser 幂等创建并在已有用户上合并字段", async () => {
  const app = await setup()
  try {
    const first = await app.users.ensureUser({ userId: "u1", displayName: "Alice" })
    assert.equal(first.created, true)

    const second = await app.users.ensureUser({ userId: "u1" })
    assert.equal(second.created, false)
    assert.equal(second.user.displayName, "Alice")

    const third = await app.users.ensureUser({ userId: "u1", note: "debug" })
    assert.equal(third.created, false)
    assert.equal(third.user.note, "debug")
    assert.equal(third.user.displayName, "Alice")
  } finally {
    await app.dispose()
  }
})

test("updateUser 更新字段并用 null 清空", async () => {
  const app = await setup()
  try {
    await app.users.createUser({ userId: "u1", displayName: "Alice", note: "x" })
    const updated = await app.users.updateUser("u1", { displayName: "Bob", note: null })
    assert.equal(updated.displayName, "Bob")
    assert.equal(updated.note, null)

    await assert.rejects(
      () => app.users.updateUser("missing", { displayName: "x" }),
      (error) => error instanceof DebugUserError && error.code === "user-not-found",
    )
  } finally {
    await app.dispose()
  }
})

test("listUsers 按创建时间倒序游标分页", async () => {
  const app = await setup()
  try {
    await app.users.createUser({ userId: "u1" })
    await app.users.createUser({ userId: "u2" })
    await app.users.createUser({ userId: "u3" })

    const page1 = await app.users.listUsers({ limit: 2 })
    assert.deepEqual(page1.items.map((item) => item.userId), ["u3", "u2"])
    assert.ok(page1.nextCursor)

    const page2 = await app.users.listUsers({ limit: 2, before: page1.nextCursor })
    assert.deepEqual(page2.items.map((item) => item.userId), ["u1"])
    assert.equal(page2.nextCursor, undefined)
  } finally {
    await app.dispose()
  }
})
