import assert from "node:assert/strict"
import test from "node:test"
import { Context } from "cordis"
import { RelationalError, RelationalStorage } from "../lib/index.js"

const ctx = new Context()
await ctx.plugin(RelationalStorage)
const relational = ctx.storageRelational

const schema = relational.defineSchema({
  tables: {
    users: {
      primaryKey: "id",
      columns: {
        id: { type: "string" },
        name: { type: "string" },
        age: { type: "integer", nullable: true },
        createdAt: { type: "datetime" },
        profile: { type: "json" },
      },
      indexes: [{ name: "users_name", fields: ["name"] }],
    },
  },
})

test("defineRelationalSchema 拒绝不存在的主键", () => {
  assert.throws(
    () =>
      relational.defineSchema({
        tables: {
          broken: {
            primaryKey: "missing",
            columns: { id: { type: "string" } },
          },
        },
      }),
    (error) => error instanceof RelationalError && error.code === "invalid-schema",
  )
})

test("assertRelationalOperation 校验条件、排序和分页", () => {
  assert.doesNotThrow(() =>
    relational.assertOperation(schema, {
      type: "find",
      table: "users",
      where: {
        type: "and",
        conditions: [
          { type: "gte", field: "age", value: 18 },
          { type: "like", field: "name", pattern: "A%" },
        ],
      },
      orderBy: [{ field: "createdAt", direction: "desc" }],
      limit: 20,
      offset: 0,
    }),
  )

  assert.throws(
    () =>
      relational.assertOperation(schema, {
        type: "find",
        table: "users",
        where: { type: "like", field: "age", pattern: "1%" },
      }),
    (error) => error instanceof RelationalError && error.code === "invalid-operation",
  )
})

test("assertRelationalOperation 拒绝修改主键和非 JSON 数据", () => {
  assert.throws(
    () =>
      relational.assertOperation(schema, {
        type: "update",
        table: "users",
        where: { type: "eq", field: "id", value: "u1" },
        patch: { id: "u2" },
      }),
    (error) => error instanceof RelationalError && error.code === "invalid-operation",
  )

  const cyclic = {}
  cyclic.self = cyclic
  assert.equal(relational.isJsonValue(cyclic), false)
})

test("relationalOperationTraits 为主键写入生成稳定一致性键", () => {
  assert.deepEqual(
    relational.operationTraits(schema, {
      type: "upsert",
      table: "users",
      value: {
        id: "u1",
        name: "Alice",
        age: null,
        createdAt: "2026-11-06T00:00:00.000Z",
        profile: {},
      },
    }),
    {
      access: "write",
      consistencyKey: `users:"u1"`,
      merge: "replaceable",
      retry: "idempotent",
      invalidatesQueryCache: true,
    },
  )
})

test("任意条件 update 保持顺序且不声明一致性键", () => {
  assert.deepEqual(
    relational.operationTraits(schema, {
      type: "update",
      table: "users",
      where: { type: "gte", field: "age", value: 18 },
      patch: { name: "adult" },
    }),
    {
      access: "write",
      merge: "ordered",
      retry: "unsafe",
      invalidatesQueryCache: true,
    },
  )
})
