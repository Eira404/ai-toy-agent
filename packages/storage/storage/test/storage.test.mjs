import assert from "node:assert/strict"
import test from "node:test"
import { Context, Service } from "cordis"
import { StorageError, ToyStorage } from "../lib/index.js"

test("按类型和名称注册、查找以及隔离同名实例", async () => {
  const ctx = new Context()
  const rootFiber = await ctx.plugin(ToyStorage)
  const relational = { label: "database" }
  const vector = { label: "index" }

  class Sources extends Service {
    static inject = ["storage"]

    constructor(context) {
      super(context, "sources")
      context.storage.register("relational", "main", relational)
      context.storage.register("vector", "main", vector)
    }
  }

  const sourceFiber = await ctx.plugin(Sources)
  assert.equal(ctx.storage.get("relational", "main"), relational)
  assert.equal(ctx.storage.get("vector", "main"), vector)
  assert.deepEqual(ctx.storage.list(), [
    { kind: "relational", name: "main" },
    { kind: "vector", name: "main" },
  ])
  assert.deepEqual(ctx.storage.list("vector"), [{ kind: "vector", name: "main" }])

  await sourceFiber.dispose()
  assert.equal(ctx.storage.has("relational", "main"), false)
  assert.equal(ctx.storage.tryGet("vector", "main"), undefined)
  await rootFiber.dispose()
})

test("拒绝重复注册并支持提前撤销", async () => {
  const ctx = new Context()
  const rootFiber = await ctx.plugin(ToyStorage)
  let unregister

  class Source extends Service {
    static inject = ["storage"]

    constructor(context) {
      super(context, "source")
      unregister = context.storage.register("relational", "main", {})
      assert.throws(
        () => context.storage.register("relational", "main", {}),
        (error) => error instanceof StorageError && error.code === "duplicate-source",
      )
    }
  }

  const sourceFiber = await ctx.plugin(Source)
  unregister()
  assert.equal(ctx.storage.tryGet("relational", "main"), undefined)
  assert.throws(
    () => ctx.storage.get("relational", "main"),
    (error) => error instanceof StorageError && error.code === "source-not-found",
  )
  await sourceFiber.dispose()
  await rootFiber.dispose()
})
