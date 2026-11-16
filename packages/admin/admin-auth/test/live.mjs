/* global console, process */
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { Context } from "cordis"
import { Pool } from "pg"
import { ToyStorage } from "toy-storage"
import { RelationalStorage } from "toy-storage-relational"
import { PostgresStorage } from "toy-storage-postgres"
import { AdminAuth, adminAuthRelationalSchema } from "../lib/index.js"

if (!process.env.DATABASE_URL) {
  throw new Error("缺少 DATABASE_URL")
}
const connectionString = process.env.DATABASE_URL
const schemaName = `toy_admin_auth_live_${randomUUID().replaceAll("-", "")}`
const pool = new Pool({ connectionString, connectionTimeoutMillis: 5000 })
const apps = []
let schemaCreated = false
const password = "live-only strong password 123!"
const root = { loginName: "owner", password }
const otherInput = { loginName: "other", password }
const errorCode = (expected) => (error) => error.code === expected

async function mount() {
  const ctx = new Context()
  const fibers = []
  const app = {
    ctx,
    async dispose() {
      for (const fiber of fibers.reverse()) {
        await fiber.dispose()
      }
    },
  }
  apps.push(app)
  fibers.push(await ctx.plugin(ToyStorage))
  fibers.push(await ctx.plugin(RelationalStorage))
  fibers.push(
    await ctx.plugin(PostgresStorage, {
      name: "main",
      connectionString,
      schemaName,
      createMissing: true,
      schema: adminAuthRelationalSchema,
      connectionTimeoutMs: 5000,
    }),
  )
  fibers.push(await ctx.plugin(AdminAuth, { maxLoginAttempts: 2 }))
  return ctx.adminAuth
}

try {
  await pool.query(`CREATE SCHEMA "${schemaName}"`)
  schemaCreated = true
  const a = await mount()
  const b = await mount()
  const initial = await Promise.allSettled([a.bootstrap(root), b.bootstrap(otherInput)])
  assert.equal(initial.filter((result) => result.status === "fulfilled").length, 1)
  assert.equal(
    initial.find((result) => result.status === "rejected").reason.code,
    "already-initialized",
  )
  const winner = initial[0].status === "fulfilled" ? root : otherInput
  const loser = winner === root ? otherInput : root
  let owner = await a.login(winner)
  const second = await a.createAdmin(owner.token, { ...loser, role: "superadmin" })
  const secondLogin = await b.login(loser)
  const disabled = await Promise.allSettled([
    a.disableAdmin(owner.token, owner.admin.adminId),
    b.disableAdmin(secondLogin.token, second.adminId),
  ])
  assert.equal(disabled.filter((result) => result.status === "fulfilled").length, 1)
  assert.equal(
    disabled.find((result) => result.status === "rejected").reason.code,
    "last-superadmin",
  )
  const current = disabled[0].status === "rejected" ? owner : secondLogin
  const currentInput = disabled[0].status === "rejected" ? winner : loser
  const disabledId = disabled[0].status === "fulfilled" ? owner.admin.adminId : second.adminId
  await a.enableAdmin(current.token, disabledId)
  owner = await a.login(winner)
  await b.authenticate(owner.token)
  await b.revokeAdminSessions(current.token, owner.admin.adminId)
  await assert.rejects(a.authenticate(owner.token), errorCode("unauthenticated"))
  owner = await a.login(currentInput)
  await assert.rejects(
    a.login({ loginName: "missing", password }),
    errorCode("invalid-credentials"),
  )
  await assert.rejects(
    b.login({ loginName: " MISSING ", password }),
    errorCode("invalid-credentials"),
  )
  await assert.rejects(a.login({ loginName: "missing", password }), errorCode("rate-limited"))
  const c = await mount()
  await c.authenticate(owner.token)
  await assert.rejects(
    c.bootstrap({ loginName: "third", password }),
    errorCode("already-initialized"),
  )
  await c.changePassword(owner.token, {
    currentPassword: password,
    newPassword: "updated live password 456!",
  })
  await assert.rejects(a.authenticate(owner.token), errorCode("unauthenticated"))
  const fresh = await a.login({ ...currentInput, password: "updated live password 456!" })
  await b.authenticate(fresh.token)
  await b.logout(fresh.token)
  await assert.rejects(a.authenticate(fresh.token), errorCode("unauthenticated"))
  const privileged = await a.login({ ...currentInput, password: "updated live password 456!" })
  const reader = await a.createAdmin(privileged.token, { loginName: "reader", password })
  const readerLogin = await b.login({ loginName: "reader", password })
  await assert.rejects(
    b.createAdmin(readerLogin.token, { loginName: "forbidden", password }),
    errorCode("forbidden"),
  )
  await a.setAdminRole(privileged.token, reader.adminId, "admin")
  await assert.rejects(b.authenticate(readerLogin.token), errorCode("unauthenticated"))
  assert.equal((await b.login({ loginName: "reader", password })).admin.role, "admin")
  console.log(
    "PostgreSQL 验证通过：并发初始化、最后管理员保护、跨实例限流、密码修改、会话撤销和重载。",
  )
} finally {
  for (const app of apps.reverse()) {
    await app.dispose()
  }
  // schemaName 由固定前缀与随机 UUID 组成，仅删除本次测试创建的隔离 schema。
  try {
    if (schemaCreated) {
      await pool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`)
    }
  } finally {
    await pool.end()
  }
}
