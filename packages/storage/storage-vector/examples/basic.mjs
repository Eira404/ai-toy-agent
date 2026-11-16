/* global console */
import { Context } from "cordis"
import { VectorStorage } from "toy-storage-vector"

const ctx = new Context()
const plugin = await ctx.plugin(VectorStorage)

try {
  const schema = ctx.storageVector.defineSchema({
    collections: {
      memories_v1: {
        dimensions: 3,
        metric: "cosine",
        filterFields: { userId: "string", category: "string" },
      },
    },
  })

  const upsert = {
    type: "upsert",
    collection: "memories_v1",
    value: {
      id: "memory-42",
      vector: [0.2, 0.3, 0.4],
      fields: { userId: "u1", category: "preference" },
      payload: { text: "用户喜欢听故事" },
    },
  }

  // 检索时两个条件必须同时满足，adapter 在候选记录中计算 Top K。
  const search = {
    type: "search",
    collection: "memories_v1",
    vector: [0.2, 0.3, 0.4],
    where: {
      type: "and",
      conditions: [
        { type: "eq", field: "userId", value: "u1" },
        { type: "eq", field: "category", value: "preference" },
      ],
    },
    limit: 10,
  }

  for (const operation of [upsert, search]) {
    ctx.storageVector.assertOperation(schema, operation)
    console.log("已通过协议校验，可交给 adapter 执行", operation)
  }
} finally {
  await plugin.dispose()
}
