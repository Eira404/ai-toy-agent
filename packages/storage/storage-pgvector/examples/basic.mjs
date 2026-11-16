/* global console, process */
// import { randomUUID } from "node:crypto"
import { Context } from "cordis"
import { Pool } from "pg"
import { ToyStorage } from "toy-storage"
import { PgvectorStorage } from "toy-storage-pgvector"
import { VectorStorage } from "toy-storage-vector"

const connectionString = process.env.DATABASE_URL
if (!connectionString) {
  throw new Error("缺少 DATABASE_URL，请检查仓库根目录的 .env")
}

const ctx = new Context()
const storage = await ctx.plugin(ToyStorage)
const vector = await ctx.plugin(VectorStorage)
// const schemaName = `toy_pgvector_example_${randomUUID().replaceAll("-", "")}`
const schemaName = `toy_pgvector_example_001`
const cleanupPool = new Pool({ connectionString, connectionTimeoutMillis: 5_000 })
let pgvector

try {
  pgvector = await ctx.plugin(PgvectorStorage, {
    name: "main",
    connectionString,
    schemaName,
    createMissing: true,
    schema: {
      collections: {
        memories: {
          dimensions: 3,
          metric: "cosine",
          filterFields: { userId: "string", category: "string" },
        },
      },
    },
  })
  const store = ctx.storage.get("vector", "main")

  await store.execute({
    type: "upsert",
    collection: "memories",
    value: {
      id: "memory-42",
      vector: [1, 0, 0],
      fields: { userId: "u1", category: "preference" },
      payload: { text: "用户喜欢听故事" },
    },
  })
  const { matches } = await store.execute({
    type: "search",
    collection: "memories",
    vector: [1, 1, 0],
    where: {
      type: "and",
      conditions: [
        { type: "eq", field: "userId", value: "u1" },
        { type: "eq", field: "category", value: "preference" },
      ],
    },
    limit: 5,
  })
  console.log(JSON.stringify(matches, null, 2))
} finally {
  try {
    await pgvector?.dispose()
    await vector.dispose()
    await storage.dispose()
  } finally {
    try {
      // await cleanupPool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`)
    } finally {
      await cleanupPool.end()
    }
  }
}
