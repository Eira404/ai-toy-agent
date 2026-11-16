import assert from "node:assert/strict"
import test from "node:test"
import { Context } from "cordis"
import { RelationalStorage } from "../lib/index.js"

test("关系型协议方法可通过 Cordis 服务调用", async () => {
  const ctx = new Context()
  const fiber = await ctx.plugin(RelationalStorage)
  const schema = ctx.storageRelational.defineSchema({
    tables: {
      events: {
        primaryKey: "eventId",
        columns: {
          eventId: { type: "string" },
          sessionId: { type: "string" },
          sequence: { type: "integer" },
        },
        indexes: [{ name: "events_session_sequence", fields: ["sessionId", "sequence"] }],
      },
    },
  })
  const operation = { type: "get", table: "events", key: "event-1" }
  assert.doesNotThrow(() => ctx.storageRelational.assertOperation(schema, operation))
  assert.equal(ctx.storageRelational.operationTraits(schema, operation).access, "read")
  await fiber.dispose()
})
