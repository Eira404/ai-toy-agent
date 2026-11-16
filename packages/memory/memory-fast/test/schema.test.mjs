import assert from "node:assert/strict"
import test from "node:test"
import {
  defineFastVectorSchema,
  fastRelationalSchema,
  normalizeTitleKey,
  FAST_JOBS_TABLE,
  FAST_RECORDS_TABLE,
  FAST_VECTOR_COLLECTION,
} from "../lib/index.js"

test("关系表结构：主键、可空字段与索引", () => {
  const records = fastRelationalSchema.tables[FAST_RECORDS_TABLE]
  assert.equal(records.primaryKey, "fast_id")
  assert.equal(records.columns.consumed_batch_id.nullable, true)
  assert.equal(records.columns.consumed_at.nullable, true)
  assert.equal(records.columns.created_at.type, "datetime")

  const indexNames = records.indexes.map((index) => index.name)
  assert.ok(indexNames.includes("fast_space_consumed_title"))
  assert.ok(indexNames.includes("fast_space_session_recent"))
  assert.ok(indexNames.includes("fast_write_id"))

  const jobs = fastRelationalSchema.tables[FAST_JOBS_TABLE]
  assert.equal(jobs.primaryKey, "write_id")
  assert.equal(jobs.columns.lease_token.nullable, true)
  const unique = jobs.indexes.find((index) => index.name === "fast_jobs_space_session_turn")
  assert.equal(unique.unique, true)
  assert.deepEqual(unique.fields, ["memory_space_id", "session_id", "turn_id"])
})

test("向量集合：维度由参数决定，过滤字段为 camelCase", () => {
  const schema = defineFastVectorSchema(1024)
  const collection = schema.collections[FAST_VECTOR_COLLECTION]
  assert.equal(collection.dimensions, 1024)
  assert.equal(collection.metric, "cosine")
  assert.deepEqual(collection.filterFields, { userId: "string", memorySpaceId: "string" })
})

test("normalizeTitleKey：NFKC + 英文小写 + 首尾 trim", () => {
  assert.equal(normalizeTitleKey("  Hello World  "), "hello world")
  assert.equal(normalizeTitleKey("ABC"), "abc")
  assert.equal(normalizeTitleKey("  咖啡偏好 "), "咖啡偏好")
  // 全角空格在 NFKC 下转为半角空格后被 trim
  assert.equal(normalizeTitleKey("\u3000全角\u3000"), "全角")
})
