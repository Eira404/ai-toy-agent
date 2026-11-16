import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { Context } from "cordis"
import VectorStorage, { VectorError, VectorStorage as NamedVectorStorage } from "../lib/index.js"

const ctx = new Context()
let plugin
const schema = {
  collections: {
    memories: {
      dimensions: 3,
      metric: "cosine",
      filterFields: { userId: "string", priority: "number", active: "boolean" },
    },
    unfiltered: { dimensions: 1, metric: "cosine" },
  },
}
const record = {
  id: "memory-42",
  vector: [0.2, 0.3, 0.4],
  fields: { userId: "u1", priority: 0, active: false },
}
const upsert = { type: "upsert", collection: "memories", value: record }
const search = { type: "search", collection: "memories", vector: [0, 0.2, 0.4], limit: 10 }
const userFilter = { type: "eq", field: "userId", value: "u1" }

before(async () => {
  plugin = await ctx.plugin(VectorStorage)
  ctx.storageVector.defineSchema(schema)
})

after(async () => {
  await plugin.dispose()
})

test("Cordis 服务返回已校验的原 Schema 并查找集合", () => {
  assert.equal(VectorStorage, NamedVectorStorage)
  assert.equal(ctx.storageVector.defineSchema(schema), schema)
  assert.equal(ctx.storageVector.requireCollection(schema, "memories"), schema.collections.memories)
  for (const name of ["missing", "constructor", "toString"]) {
    assert.throws(() => ctx.storageVector.requireCollection(schema, name), {
      name: "VectorError",
      code: "collection-not-found",
    })
  }
})

test("拒绝错误的 Schema 结构、集合名、维度、度量和字段声明", () => {
  const definition = schema.collections.memories
  const invalidSchemas = [
    null,
    {},
    { collections: [] },
    { collections: {} },
    { collections: { "invalid-name": definition } },
  ]
  const invalidCollections = [
    null,
    { ...definition, dimensions: 0 },
    { ...definition, dimensions: 1.5 },
    { ...definition, dimensions: 2 ** 53 },
    { ...definition, metric: "unknown" },
    { ...definition, filterFields: [] },
    { ...definition, filterFields: { userId: "json" } },
    { ...definition, filterFields: { "invalid-field": "string" } },
    ...["id", "embedding", "payload"].map((field) => ({
      ...definition,
      filterFields: { [field]: "string" },
    })),
  ]
  for (const invalidSchema of [
    ...invalidSchemas,
    ...invalidCollections.map((memories) => ({ collections: { memories } })),
  ]) {
    assert.throws(() => ctx.storageVector.defineSchema(invalidSchema), {
      name: "VectorError",
      code: "invalid-schema",
    })
  }
})

test("支持完整 upsert、按 ID 读取和删除，以及没有过滤字段的集合", () => {
  const operations = [
    upsert,
    { type: "get", collection: "memories", id: record.id },
    { type: "delete", collection: "memories", id: record.id },
    {
      type: "upsert",
      collection: "unfiltered",
      value: { id: "single", vector: [-1], fields: {} },
    },
  ]
  for (const operation of operations) {
    assert.doesNotThrow(() => ctx.storageVector.assertOperation(schema, operation))
  }
})

test("拒绝未知操作、未知集合和无效 ID", () => {
  for (const operation of [null, [], { type: "get" }, { ...upsert, type: "insert" }]) {
    assertInvalidOperation(operation, "invalid-operation")
  }
  assertInvalidOperation({ ...upsert, value: null }, "invalid-operation")
  assertInvalidOperation({ ...upsert, collection: "missing" }, "collection-not-found")
  for (const id of ["", "  ", 42]) {
    assertInvalidOperation({ ...upsert, value: { ...record, id } }, "invalid-value")
    for (const type of ["get", "delete"]) {
      assertInvalidOperation({ type, collection: "memories", id }, "invalid-value")
    }
  }
})

test("批量写入逐条校验完整记录，批量删除接受重复 ID", () => {
  const write = { type: "upsertMany", collection: "memories", values: [record] }
  const deletion = { type: "deleteMany", collection: "memories", ids: [record.id, record.id] }
  for (const operation of [write, deletion]) {
    assert.doesNotThrow(() => ctx.storageVector.assertOperation(schema, operation))
  }
  assertInvalidOperation({ ...write, values: [] }, "invalid-operation")
  assertInvalidOperation({ ...write, values: [record, record] }, "invalid-value")
  assertInvalidOperation({ ...write, values: [record, { ...record, id: "" }] }, "invalid-value")
  assertInvalidOperation({ ...deletion, ids: [] }, "invalid-operation")
  assertInvalidOperation({ ...deletion, ids: [record.id, 42] }, "invalid-value")
})

test("写入和检索共同拒绝错误维度、非有限值、稀疏数组和全零向量", () => {
  for (const vector of [
    [1, 2],
    [1, 2, 3, 4],
    [1, 2, "3"],
    [1, NaN, 2],
    [1, Infinity, 2],
    [1, -Infinity, 2],
    [0, -0, 0],
    Array(3),
    new Float32Array([1, 2, 3]),
  ]) {
    assertInvalidOperation({ ...upsert, value: { ...record, vector } }, "invalid-value")
    assertInvalidOperation({ ...search, vector }, "invalid-value")
  }
})

test("完整写入要求字段全部声明、全部提供且值类型匹配", () => {
  for (const fields of [
    { ...record.fields, unknown: 1 },
    { ...record.fields, constructor: "inherited" },
    { userId: "u1", active: false },
  ]) {
    assertInvalidOperation({ ...upsert, value: { ...record, fields } }, "invalid-field")
  }
  for (const fields of [
    null,
    { ...record.fields, priority: NaN },
    { ...record.fields, active: 1 },
  ]) {
    assertInvalidOperation({ ...upsert, value: { ...record, fields } }, "invalid-value")
  }
})

test("payload 接受嵌套 JSON 对象并拒绝循环和不能表达的值", () => {
  const shared = { nested: [1, false, null, { text: "故事" }] }
  const payload = { left: shared, right: shared }
  assert.doesNotThrow(() =>
    ctx.storageVector.assertOperation(schema, { ...upsert, value: { ...record, payload } }),
  )

  const cycle = {}
  cycle.self = cycle
  for (const payload of [
    null,
    [],
    { invalid: NaN },
    { date: new Date() },
    { a: Array(1) },
    cycle,
  ]) {
    assertInvalidOperation({ ...upsert, value: { ...record, payload } }, "invalid-value")
  }
})

test("检索支持省略过滤、单个 eq 或多个条件同时匹配", () => {
  const and = {
    type: "and",
    conditions: [
      userFilter,
      { type: "eq", field: "active", value: false },
      { type: "eq", field: "priority", value: 0 },
    ],
  }
  for (const operation of [search, { ...search, where: userFilter }, { ...search, where: and }]) {
    assert.doesNotThrow(() => ctx.storageVector.assertOperation(schema, operation))
  }
})

test("逐项校验 and 的条件并拒绝空列表、嵌套列表和未知字段", () => {
  for (const where of [
    null,
    { type: "and", conditions: [] },
    { type: "and", conditions: [userFilter, { type: "and", conditions: [userFilter] }] },
    { type: "or", conditions: [userFilter] },
    { type: "eq", value: "u1" },
  ]) {
    assertInvalidOperation({ ...search, where }, "invalid-operation")
  }
  for (const field of ["unknown", "toString"]) {
    const where = { type: "and", conditions: [userFilter, { ...userFilter, field }] }
    assertInvalidOperation({ ...search, where }, "invalid-field")
  }
  const where = { type: "and", conditions: [userFilter, { ...userFilter, value: 1 }] }
  assertInvalidOperation({ ...search, where }, "invalid-value")
})

test("检索 limit 必填且必须是 1 到 100 的整数", () => {
  for (const limit of [1, 100]) {
    assert.doesNotThrow(() => ctx.storageVector.assertOperation(schema, { ...search, limit }))
  }
  for (const limit of [undefined, 0, 101, 2.5, Infinity, "10"]) {
    assertInvalidOperation({ ...search, limit }, "invalid-operation")
  }
})

test("向量错误区分可重试失败、未知提交状态和永久错误", () => {
  const cause = new Error("connection lost")
  for (const code of ["connection-failed", "timeout"]) {
    const error = new VectorError(code, "确认未提交", { cause })
    assert.equal(error.cause, cause)
    assert.equal(error.retryable, true)
    assert.equal(error.unknownState, false)
  }
  const unknown = new VectorError("unknown-commit-state", "提交结果未知")
  assert.equal(unknown.retryable, false)
  assert.equal(unknown.unknownState, true)

  const invalid = new VectorError("invalid-value", "无效数据")
  assert.equal(invalid.retryable, false)
  assert.equal(invalid.unknownState, false)
})

function assertInvalidOperation(operation, code) {
  assert.throws(
    () => ctx.storageVector.assertOperation(schema, operation),
    (error) => error instanceof VectorError && error.code === code,
  )
}
