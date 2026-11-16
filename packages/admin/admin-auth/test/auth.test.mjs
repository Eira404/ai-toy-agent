/* global structuredClone, setImmediate */
import assert from "node:assert/strict"
import test from "node:test"
import {
  AdminAuthError,
  adminAuthRelationalSchema,
  ADMIN_ACCOUNTS_TABLE as ACCOUNTS,
  ADMIN_AUTH_STATE_TABLE as STATE,
  ADMIN_SESSIONS_TABLE as SESSIONS,
  ADMIN_SECURITY_EVENTS_TABLE as EVENTS,
} from "../lib/index.js"
import { MemoryDatabase, PASSWORD, ROOT, setup, signedIn } from "./helpers.mjs"

const code = (expected) => (error) => error instanceof AdminAuthError && error.code === expected
const rows = (app, table) => [...app.database.rows.get(table).values()]

test("首次初始化、登录、身份与公开字段；不存储原始密码和 Token", async (t) => {
  const app = await setup()
  t.after(() => app.dispose())
  const admin = await app.auth.bootstrap({ ...ROOT, loginName: " Root ", displayName: "管理员" })
  assert.equal(admin.loginName, "root")
  assert.equal(admin.displayName, "管理员")
  const login = await app.auth.login({ ...ROOT, loginName: " ROOT " })
  assert.equal((await app.auth.authenticate(login.token)).sessionId, login.sessionId)
  assert.deepEqual(await app.auth.getMe(login.token), admin)
  assert.deepEqual(await app.auth.getAdmin(login.token, admin.adminId), admin)
  assert.equal(await app.auth.getAdmin(login.token, "missing"), undefined)
  const saved = rows(app, ACCOUNTS)[0]
  assert.match(saved.password_hash, /^scrypt\$32768\$8\$3\$/)
  const serialized = JSON.stringify(
    [...app.database.rows].map(([name, records]) => [name, [...records.values()]]),
  )
  assert.equal(serialized.includes(PASSWORD), false)
  assert.equal(serialized.includes(login.token), false)
  assert.equal(JSON.stringify(admin).includes("hash"), false)
  assert.equal(
    JSON.stringify(await app.auth.listAdmins(login.token)).includes("security_version"),
    false,
  )
})

test("跨插件实例并发初始化只能成功一次，重载也不能再次初始化", async (t) => {
  const a = await setup()
  const b = await setup({}, a.database)
  t.after(async () => {
    await b.dispose()
    await a.dispose()
  })
  const results = await Promise.allSettled([
    a.auth.bootstrap(ROOT),
    b.auth.bootstrap({ ...ROOT, loginName: "other" }),
  ])
  assert.equal(results.filter((item) => item.status === "fulfilled").length, 1)
  assert.ok(code("already-initialized")(results.find((item) => item.status === "rejected").reason))
  assert.equal(rows(a, ACCOUNTS).length, 1)
  assert.equal(rows(a, STATE)[0].bootstrapped, true)
  await assert.rejects(
    b.auth.bootstrap({ ...ROOT, loginName: "third" }),
    code("already-initialized"),
  )
})

test("缺失账号、密码错误和禁用账号返回统一错误；失败记录在抛错后保留", async (t) => {
  const app = await signedIn()
  t.after(() => app.dispose())
  await assert.rejects(
    app.auth.login({ loginName: "missing", password: PASSWORD }),
    code("invalid-credentials"),
  )
  await assert.rejects(
    app.auth.login({ ...ROOT, password: "wrong password" }),
    code("invalid-credentials"),
  )
  const other = await app.auth.createAdmin(app.login.token, { ...ROOT, loginName: "other" })
  await app.auth.disableAdmin(app.login.token, other.adminId)
  await assert.rejects(app.auth.login({ ...ROOT, loginName: "other" }), code("invalid-credentials"))
  assert.equal(rows(app, EVENTS).filter((row) => row.outcome === "invalid-credentials").length, 3)
})

test("登录限制覆盖未知账号、规范化别名及跨实例；窗口到期后恢复", async (t) => {
  let now = "2026-11-13T00:00:00.000Z"
  const config = { now: () => now, maxLoginAttempts: 2, loginWindowMs: 1000 }
  const a = await setup(config)
  const b = await setup(config, a.database)
  t.after(async () => {
    await b.dispose()
    await a.dispose()
  })
  await assert.rejects(
    a.auth.login({ loginName: "missing", password: PASSWORD }),
    code("invalid-credentials"),
  )
  await assert.rejects(
    b.auth.login({ loginName: " MISSING ", password: PASSWORD }),
    code("invalid-credentials"),
  )
  await assert.rejects(
    a.auth.login({ loginName: "missing", password: PASSWORD }),
    code("rate-limited"),
  )
  now = "2026-11-13T00:00:01.001Z"
  await assert.rejects(
    b.auth.login({ loginName: "missing", password: PASSWORD }),
    code("invalid-credentials"),
  )
})

test("进行中的登录预占限制额度，不能并发越过阈值", async (t) => {
  const app = await setup({ maxLoginAttempts: 1 })
  t.after(() => app.dispose())
  const results = await Promise.allSettled([
    app.auth.login({ loginName: "unknown", password: PASSWORD }),
    app.auth.login({ loginName: "unknown", password: PASSWORD }),
  ])
  assert.deepEqual(results.map((item) => item.reason.code).sort(), [
    "invalid-credentials",
    "rate-limited",
  ])
})

test("退出仅撤销一个会话且可重复退出；过期边界拒绝访问", async (t) => {
  let now = "2026-11-13T00:00:00.000Z"
  const app = await signedIn({ now: () => now, sessionTtlMs: 1000 })
  t.after(() => app.dispose())
  const second = await app.auth.login(ROOT)
  assert.notEqual(app.login.token, second.token)
  await app.auth.logout(app.login.token)
  await app.auth.logout(app.login.token)
  await assert.rejects(app.auth.authenticate(app.login.token), code("unauthenticated"))
  await app.auth.authenticate(second.token)
  now = second.expiresAt
  await assert.rejects(app.auth.authenticate(second.token), code("unauthenticated"))
  await assert.rejects(
    app.auth.createAdmin(second.token, { ...ROOT, loginName: "unauthorized" }),
    code("unauthenticated"),
  )
})

test("后续账号注册需有效管理员；同名并发创建和规范化重复不能通过", async (t) => {
  const app = await signedIn()
  t.after(() => app.dispose())
  await assert.rejects(
    app.auth.createAdmin("forged", { ...ROOT, loginName: "other" }),
    code("unauthenticated"),
  )
  const result = await Promise.allSettled([
    app.auth.createAdmin(app.login.token, { ...ROOT, loginName: "other" }),
    app.auth.createAdmin(app.login.token, { ...ROOT, loginName: " OTHER " }),
  ])
  assert.equal(result.filter((item) => item.status === "fulfilled").length, 1)
  assert.ok(code("admin-exists")(result.find((item) => item.status === "rejected").reason))
  assert.equal(rows(app, ACCOUNTS).length, 2)
})

test("同时间戳下分页稳定，不重复或跳过账号，公开结果不泄漏密码", async (t) => {
  const app = await signedIn({ now: () => "2026-11-13T00:00:00.000Z" })
  t.after(() => app.dispose())
  await app.auth.createAdmin(app.login.token, { ...ROOT, loginName: "second" })
  await app.auth.createAdmin(app.login.token, { ...ROOT, loginName: "third" })
  const seen = []
  let before
  do {
    const page = await app.auth.listAdmins(app.login.token, {
      limit: 1,
      ...(before ? { before } : {}),
    })
    assert.equal(page.items.length, 1)
    seen.push(page.items[0].adminId)
    before = page.nextCursor
  } while (before)
  assert.equal(new Set(seen).size, 3)
  await assert.rejects(app.auth.listAdmins(app.login.token, { limit: 101 }), code("invalid-input"))
  await assert.rejects(
    app.auth.listAdmins(app.login.token, { before: { createdAt: "bad", adminId: "x" } }),
    code("invalid-input"),
  )
})

test("最后一个超级管理员不能禁用；并发自禁用仍保留一个有效超级管理员", async (t) => {
  const a = await signedIn()
  const b = await setup({}, a.database)
  t.after(async () => {
    await b.dispose()
    await a.dispose()
  })
  await assert.rejects(a.auth.disableAdmin(a.login.token, a.admin.adminId), code("last-superadmin"))
  const other = await a.auth.createAdmin(a.login.token, {
    ...ROOT,
    loginName: "other",
    role: "superadmin",
  })
  const login = await b.auth.login({ ...ROOT, loginName: "other" })
  const results = await Promise.allSettled([
    a.auth.disableAdmin(a.login.token, a.admin.adminId),
    b.auth.disableAdmin(login.token, other.adminId),
  ])
  assert.equal(results.filter((item) => item.status === "fulfilled").length, 1)
  assert.ok(code("last-superadmin")(results.find((item) => item.status === "rejected").reason))
  assert.equal(
    rows(a, ACCOUNTS).filter((row) => row.enabled && row.role === "superadmin").length,
    1,
  )
})

test("禁用立即撤销全部会话，重新启用不恢复旧会话", async (t) => {
  const app = await signedIn()
  t.after(() => app.dispose())
  const other = await app.auth.createAdmin(app.login.token, { ...ROOT, loginName: "other" })
  const login = await app.auth.login({ ...ROOT, loginName: "other" })
  await app.auth.disableAdmin(app.login.token, other.adminId)
  await assert.rejects(app.auth.getMe(login.token), code("unauthenticated"))
  await app.auth.enableAdmin(app.login.token, other.adminId)
  await assert.rejects(app.auth.getMe(login.token), code("unauthenticated"))
  await app.auth.login({ ...ROOT, loginName: "other" })
})

test("修改密码原子撤销所有登录，旧密码失败、新密码成功", async (t) => {
  const app = await signedIn()
  t.after(() => app.dispose())
  const second = await app.auth.login(ROOT)
  await assert.rejects(
    app.auth.changePassword(app.login.token, {
      currentPassword: "wrong",
      newPassword: "new strong password 456!",
    }),
    code("invalid-credentials"),
  )
  await app.auth.authenticate(app.login.token)
  await app.auth.changePassword(app.login.token, {
    currentPassword: PASSWORD,
    newPassword: "new strong password 456!",
  })
  await assert.rejects(app.auth.authenticate(app.login.token), code("unauthenticated"))
  await assert.rejects(app.auth.authenticate(second.token), code("unauthenticated"))
  await assert.rejects(app.auth.login(ROOT), code("invalid-credentials"))
  await app.auth.login({ ...ROOT, password: "new strong password 456!" })
})

test("主动/指定账号强制下线均撤销全部会话", async (t) => {
  const app = await signedIn()
  t.after(() => app.dispose())
  const other = await app.auth.createAdmin(app.login.token, { ...ROOT, loginName: "other" })
  const login = await app.auth.login({ ...ROOT, loginName: "other" })
  await app.auth.revokeAdminSessions(app.login.token, other.adminId)
  await assert.rejects(app.auth.authenticate(login.token), code("unauthenticated"))
  const second = await app.auth.login(ROOT)
  await app.auth.revokeMySessions(app.login.token)
  await assert.rejects(app.auth.authenticate(app.login.token), code("unauthenticated"))
  await assert.rejects(app.auth.authenticate(second.token), code("unauthenticated"))
})

test("强制下线也阻止已在计算密码的旧登录请求发放 Token", async (t) => {
  const app = await signedIn()
  t.after(() => app.dispose())
  let reserved = false
  app.database.beforeExecute = async (op) => {
    if (op.type === "insert" && op.table === EVENTS && op.value.outcome === "pending") {
      reserved = true
    }
  }
  const pending = app.auth.login(ROOT)
  const outcome = pending.then(
    () => "unexpected",
    (error) => error.code,
  )
  while (!reserved) {
    await new Promise(setImmediate)
  }
  await app.auth.revokeMySessions(app.login.token)
  assert.equal(await outcome, "invalid-credentials")
  assert.equal(rows(app, SESSIONS).filter((row) => row.revoked_at === null).length, 0)
})

test("过期/撤销会话按批次清理，不移除有效会话", async (t) => {
  let now = "2026-11-13T00:00:00.000Z"
  const app = await signedIn({ now: () => now, sessionTtlMs: 1000 })
  t.after(() => app.dispose())
  const second = await app.auth.login(ROOT)
  await app.auth.logout(second.token)
  now = "2026-11-13T00:00:01.000Z"
  const current = await app.auth.login(ROOT)
  assert.equal(await app.auth.cleanupExpiredSessions(current.token, 1), 1)
  assert.equal(await app.auth.cleanupExpiredSessions(current.token), 1)
  assert.equal(await app.auth.cleanupExpiredSessions(current.token), 0)
  await app.auth.authenticate(current.token)
})

test("安全事件写入失败时回滚初始化和密码修改，不留下半完成的安全状态", async (t) => {
  const app = await setup()
  t.after(() => app.dispose())
  app.database.beforeExecute = async (op) => {
    if (op.type === "insert" && op.table === EVENTS) {
      throw new Error("audit unavailable")
    }
  }
  await assert.rejects(app.auth.bootstrap(ROOT), /audit unavailable/)
  assert.equal(rows(app, ACCOUNTS).length, 0)
  assert.equal(rows(app, STATE)[0].bootstrapped, false)
  app.database.beforeExecute = undefined
  await app.auth.bootstrap(ROOT)
  const login = await app.auth.login(ROOT)
  const previousHash = rows(app, ACCOUNTS)[0].password_hash
  app.database.beforeExecute = async (op) => {
    if (op.type === "insert" && op.table === EVENTS && op.value.action === "change-password") {
      throw new Error("audit unavailable")
    }
  }
  await assert.rejects(
    app.auth.changePassword(login.token, {
      currentPassword: PASSWORD,
      newPassword: "new strong password 456!",
    }),
    /audit unavailable/,
  )
  assert.equal(rows(app, ACCOUNTS)[0].password_hash, previousHash)
  await app.auth.authenticate(login.token)
})

test("插件重载后登录仍有效，卸载后的旧服务引用拒绝调用", async () => {
  const app = await signedIn()
  const token = app.login.token
  const database = app.database
  await app.dispose()
  await assert.rejects(app.auth.authenticate(token), code("source-not-ready"))
  const reloaded = await setup({}, database)
  try {
    await reloaded.auth.authenticate(token)
    await assert.rejects(reloaded.auth.bootstrap(ROOT), code("already-initialized"))
  } finally {
    await reloaded.dispose()
  }
})

test("拒绝无事务能力和缺少唯一约束的 adapter", async () => {
  const database = new MemoryDatabase()
  database.capabilities.transactions = false
  await assert.rejects(setup({}, database), code("transactions-required"))
  const schema = structuredClone(adminAuthRelationalSchema)
  schema.tables[ACCOUNTS].indexes = []
  await assert.rejects(setup({}, new MemoryDatabase(schema)), code("schema-mismatch"))
})

test("非法输入均在边界拒绝，伪造身份不能替代 Token", async (t) => {
  const app = await signedIn()
  t.after(() => app.dispose())
  for (const input of [
    null,
    {},
    { ...ROOT, password: "short" },
    { ...ROOT, loginName: "bad/name" },
    { ...ROOT, password: "x".repeat(129) },
    { ...ROOT, password: `${"x".repeat(12)}\ud800` },
  ]) {
    await assert.rejects(app.auth.bootstrap(input), code("invalid-input"))
  }
  for (const token of [null, "", "forged", { adminId: app.admin.adminId }]) {
    await assert.rejects(app.auth.authenticate(token), code("unauthenticated"))
  }
  await assert.rejects(app.auth.disableAdmin(app.login.token, "missing"), code("admin-not-found"))
})

test("配置输入与时钟返回值在边界校验", async () => {
  for (const config of [
    null,
    { sessionTtlMs: 0 },
    { loginWindowMs: -1 },
    { maxLoginAttempts: 0 },
    { maxConcurrentPasswordOps: 0 },
    { now: "not-a-function" },
  ]) {
    await assert.rejects(setup(config), code("invalid-input"))
  }
  const app = await setup({ now: () => "invalid-date" })
  try {
    await assert.rejects(app.auth.bootstrap(ROOT), code("invalid-input"))
    assert.equal(rows(app, ACCOUNTS).length, 0)
  } finally {
    await app.dispose()
  }
})

test("账号被禁用后，正在计算密码的创建请求也不能提交", async (t) => {
  const app = await signedIn()
  t.after(() => app.dispose())
  const other = await app.auth.createAdmin(app.login.token, {
    ...ROOT,
    loginName: "other",
    role: "admin",
  })
  const otherLogin = await app.auth.login({ ...ROOT, loginName: "other" })
  let checked = false
  app.database.beforeExecute = async (op) => {
    if (op.type === "get" && op.table === ACCOUNTS && op.key === other.adminId) {
      checked = true
    }
  }
  const outcome = app.auth.createAdmin(otherLogin.token, { ...ROOT, loginName: "forbidden" }).then(
    () => "unexpected",
    (error) => error.code,
  )
  while (!checked) {
    await new Promise(setImmediate)
  }
  await app.auth.disableAdmin(app.login.token, other.adminId)
  assert.equal(await outcome, "unauthenticated")
  assert.equal(
    rows(app, ACCOUNTS).some((row) => row.login_name === "forbidden"),
    false,
  )
})

test("密码计算并发上限立即拒绝，繁忙尝试不占用失败额度", async (t) => {
  const app = await setup({ maxConcurrentPasswordOps: 1, maxLoginAttempts: 5 })
  t.after(() => app.dispose())
  const results = await Promise.allSettled([
    app.auth.login({ loginName: "missing", password: PASSWORD }),
    app.auth.login({ loginName: "another", password: PASSWORD }),
  ])
  assert.deepEqual(results.map((item) => item.reason.code).sort(), [
    "auth-busy",
    "invalid-credentials",
  ])
  assert.equal(rows(app, EVENTS).filter((row) => row.outcome === "auth-busy").length, 1)
})
