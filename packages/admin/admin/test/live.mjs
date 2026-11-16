/* global console, process */
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { Context } from "cordis"
import { Pool } from "pg"
import { ToyStorage } from "toy-storage"
import { RelationalStorage } from "toy-storage-relational"
import { PostgresStorage } from "toy-storage-postgres"
import { AdminAuth, adminAuthRelationalSchema } from "toy-admin-auth"
import { Admin, adminRelationalSchema, ADMIN_OPERATIONS_TABLE } from "../lib/index.js"

if (!process.env.DATABASE_URL) {
  throw new Error("缺少 DATABASE_URL")
}
const connectionString = process.env.DATABASE_URL
const schemaName = `toy_admin_live_${randomUUID().replaceAll("-", "")}`
const pool = new Pool({ connectionString, connectionTimeoutMillis: 5000 })
const apps = []
let created = false

async function mount() {
  const ctx = new Context()
  const fibers = []
  apps.push({
    ctx,
    async dispose() {
      if (ctx.admin) {
        ctx.admin.stop()
        await ctx.admin.waitForIdle({ timeoutMs: 2000 })
      }
      for (const fiber of fibers.reverse()) {
        await fiber.dispose()
      }
    },
  })
  fibers.push(await ctx.plugin(ToyStorage))
  fibers.push(await ctx.plugin(RelationalStorage))
  fibers.push(
    await ctx.plugin(PostgresStorage, {
      name: "main",
      connectionString,
      schemaName,
      createMissing: true,
      schema: { tables: { ...adminAuthRelationalSchema.tables, ...adminRelationalSchema.tables } },
      connectionTimeoutMs: 5000,
    }),
  )
  fibers.push(await ctx.plugin(AdminAuth))
  fibers.push(await ctx.plugin(Admin))
  ctx.admin.register({
    name: "example.echo",
    description: "隔离实库验证能力，无业务运维",
    kind: "query",
    roles: ["superadmin", "admin"],
    bindings: [{ transport: "http", method: "POST", path: "/example/echo" }],
    input: {
      type: "object",
      properties: { value: { type: "integer" } },
      required: ["value"],
      additionalProperties: false,
    },
    output: { type: "integer" },
    audit: () => ({ sample: true }),
    execute: (input) => input.value,
  })
  return ctx
}

try {
  await pool.query(`CREATE SCHEMA "${schemaName}"`)
  created = true
  const a = await mount()
  const b = await mount()
  const credentials = { loginName: "owner", password: "live example password 123!" }
  await a.adminAuth.bootstrap(credentials)
  const owner = await a.adminAuth.login(credentials)
  const reader = await a.adminAuth.createAdmin(owner.token, { ...credentials, loginName: "reader" })
  let login = await a.adminAuth.login({ ...credentials, loginName: "reader" })
  const call = (token) => b.admin.execute("example.echo", { token, input: { value: 42 } })
  await assert.rejects(call(login.token), (error) => error.code === "forbidden")
  await a.adminAuth.setAdminRole(owner.token, reader.adminId, "admin")
  await assert.rejects(call(login.token), (error) => error.code === "unauthenticated")
  login = await a.adminAuth.login({ ...credentials, loginName: "reader" })
  assert.equal(await call(login.token), 42)
  const database = b.storage.get("relational", "main")
  const result = await database.execute({ type: "find", table: ADMIN_OPERATIONS_TABLE })
  assert.equal(result.rows.length, 3)
  const success = result.rows.find((row) => row.status === "succeeded")
  assert.deepEqual(success.summary, { sample: true })
  assert.equal(success.admin_id, reader.adminId)
  assert.equal(success.execution_state, "succeeded")
  const serialized = JSON.stringify(result.rows)
  assert.equal(serialized.includes(login.token), false)
  assert.equal(serialized.includes(credentials.password), false)
  console.log("PostgreSQL 验证通过：两个 Context 的真实认证、角色变更、分发和持久化审计。")
} finally {
  for (const app of apps.reverse()) {
    await app.dispose()
  }
  try {
    // 固定前缀与随机 UUID，只删除本次测试显式创建的隔离 schema。
    if (created) {
      await pool.query(`DROP SCHEMA "${schemaName}" CASCADE`)
    }
  } finally {
    await pool.end()
  }
}
