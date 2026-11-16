/* global structuredClone, setImmediate */
import assert from "node:assert/strict"
import test from "node:test"
import {
  ADMIN_PERMISSIONS,
  AdminAuthError,
  adminAuthRelationalSchema,
  ADMIN_ACCOUNTS_TABLE as ACCOUNTS,
  ADMIN_SECURITY_EVENTS_TABLE as EVENTS,
} from "../lib/index.js"
import { MemoryDatabase, ROOT, setup, signedIn } from "./helpers.mjs"

const code = (expected) => (error) => error instanceof AdminAuthError && error.code === expected

async function actors(t) {
  const app = await signedIn()
  t.after(() => app.dispose())
  app.manager = await app.auth.createAdmin(app.login.token, {
    ...ROOT,
    loginName: "manager",
    role: "admin",
  })
  app.viewer = await app.auth.createAdmin(app.login.token, { ...ROOT, loginName: "viewer" })
  app.managerLogin = await app.auth.login({ ...ROOT, loginName: "manager" })
  app.viewerLogin = await app.auth.login({ ...ROOT, loginName: "viewer" })
  return app
}

test("首个账号固定为超级管理员，创建默认只读，拒绝未知角色和伪造 bootstrap 角色", async (t) => {
  const app = await signedIn()
  t.after(() => app.dispose())
  assert.equal(app.admin.role, "superadmin")
  const viewer = await app.auth.createAdmin(app.login.token, { ...ROOT, loginName: "reader" })
  assert.equal(viewer.role, "viewer")
  for (const role of [null, "owner", "SUPERADMIN", 1]) {
    await assert.rejects(
      app.auth.createAdmin(app.login.token, { ...ROOT, role }),
      code("invalid-input"),
    )
    await assert.rejects(
      app.auth.setAdminRole(app.login.token, viewer.adminId, role),
      code("invalid-input"),
    )
  }
  await assert.rejects(app.auth.bootstrap({ ...ROOT, role: "viewer" }), code("invalid-input"))
})

test("三类角色权限表落实到 authorize，全部可以读取公开资料", async (t) => {
  const app = await actors(t)
  const expected = {
    superadmin: ADMIN_PERMISSIONS,
    admin: ["admins.read", "admins.create", "admins.manage"],
    viewer: ["admins.read"],
  }
  for (const login of [app.login, app.managerLogin, app.viewerLogin]) {
    for (const permission of ADMIN_PERMISSIONS) {
      if (expected[login.admin.role].includes(permission)) {
        assert.equal(
          (await app.auth.authorize(login.token, permission)).admin.role,
          login.admin.role,
        )
      } else {
        await assert.rejects(app.auth.authorize(login.token, permission), code("forbidden"))
      }
    }
    assert.equal((await app.auth.listAdmins(login.token)).items.length, 3)
    assert.equal((await app.auth.getAdmin(login.token, app.admin.adminId)).role, "superadmin")
  }
  await assert.rejects(app.auth.authorize(app.login.token, "made-up"), code("invalid-input"))
})

test("只读管理员不能修改其他账号，但可以维护自己的密码和登录会话", async (t) => {
  const app = await actors(t)
  const token = app.viewerLogin.token
  for (const action of [
    () => app.auth.createAdmin(token, { ...ROOT, loginName: "forbidden" }),
    () => app.auth.disableAdmin(token, app.manager.adminId),
    () => app.auth.enableAdmin(token, app.manager.adminId),
    () => app.auth.revokeAdminSessions(token, app.manager.adminId),
    () => app.auth.setAdminRole(token, app.viewer.adminId, "superadmin"),
    () => app.auth.cleanupExpiredSessions(token),
  ]) {
    await assert.rejects(action(), code("forbidden"))
  }
  await app.auth.changePassword(token, {
    currentPassword: ROOT.password,
    newPassword: "viewer new password 456!",
  })
  await assert.rejects(app.auth.authenticate(token), code("unauthenticated"))
  const login = await app.auth.login({ loginName: "viewer", password: "viewer new password 456!" })
  assert.equal(login.admin.role, "viewer")
  await app.auth.revokeMySessions(login.token)
  await assert.rejects(app.auth.authenticate(login.token), code("unauthenticated"))
  await app.auth.authenticate(app.login.token)
})

test("普通管理员只能创建和管理只读账号，不能操作同级/超级管理员或改变等级", async (t) => {
  const app = await actors(t)
  const token = app.managerLogin.token
  const reader = await app.auth.createAdmin(token, { ...ROOT, loginName: "reader" })
  assert.equal(reader.role, "viewer")
  const readerLogin = await app.auth.login({ ...ROOT, loginName: "reader" })
  await app.auth.revokeAdminSessions(token, reader.adminId)
  await assert.rejects(app.auth.authenticate(readerLogin.token), code("unauthenticated"))
  await app.auth.disableAdmin(token, reader.adminId)
  assert.equal((await app.auth.getAdmin(token, reader.adminId)).enabled, false)
  await app.auth.enableAdmin(token, reader.adminId)
  for (const role of ["admin", "superadmin"]) {
    await assert.rejects(
      app.auth.createAdmin(token, { ...ROOT, loginName: `bad-${role}`, role }),
      code("forbidden"),
    )
  }
  for (const target of [app.admin, app.manager]) {
    for (const action of ["disableAdmin", "enableAdmin", "revokeAdminSessions"]) {
      await assert.rejects(app.auth[action](token, target.adminId), code("forbidden"))
    }
  }
  await assert.rejects(app.auth.setAdminRole(token, reader.adminId, "admin"), code("forbidden"))
  await assert.rejects(app.auth.cleanupExpiredSessions(token), code("forbidden"))
})

test("等级变更撤销全部旧会话，重新登录按新等级鉴权，重复设置不撤销", async (t) => {
  const app = await actors(t)
  const second = await app.auth.login({ ...ROOT, loginName: "manager" })
  const changed = await app.auth.setAdminRole(app.login.token, app.manager.adminId, "viewer")
  assert.equal(changed.role, "viewer")
  await assert.rejects(app.auth.authenticate(app.managerLogin.token), code("unauthenticated"))
  await assert.rejects(app.auth.authenticate(second.token), code("unauthenticated"))
  const login = await app.auth.login({ ...ROOT, loginName: "manager" })
  await assert.rejects(app.auth.authorize(login.token, "admins.create"), code("forbidden"))
  await app.auth.setAdminRole(app.login.token, app.manager.adminId, "viewer")
  await app.auth.authenticate(login.token)
  const events = [...app.database.rows.get(EVENTS).values()].filter(
    (row) => row.action === "set-role",
  )
  assert.equal(events.length, 1)
  assert.equal(events[0].actor_id, app.admin.adminId)
  assert.equal(events[0].target_id, app.manager.adminId)
  await app.auth.setAdminRole(app.login.token, app.viewer.adminId, "superadmin")
  const promoted = await app.auth.login({ ...ROOT, loginName: "viewer" })
  await app.auth.authorize(promoted.token, "admins.roles")
})

test("普通/只读账号仍在时也不能禁用或降级最后一个超级管理员", async (t) => {
  const app = await actors(t)
  await assert.rejects(
    app.auth.disableAdmin(app.login.token, app.admin.adminId),
    code("last-superadmin"),
  )
  for (const role of ["admin", "viewer"]) {
    await assert.rejects(
      app.auth.setAdminRole(app.login.token, app.admin.adminId, role),
      code("last-superadmin"),
    )
  }
  assert.equal((await app.auth.getMe(app.login.token)).role, "superadmin")
})

test("跨实例并发降级/禁用仍保留一个有效超级管理员", async (t) => {
  const app = await signedIn()
  const other = await setup({}, app.database)
  t.after(async () => {
    await other.dispose()
    await app.dispose()
  })
  const second = await app.auth.createAdmin(app.login.token, {
    ...ROOT,
    loginName: "second",
    role: "superadmin",
  })
  const login = await other.auth.login({ ...ROOT, loginName: "second" })
  const results = await Promise.allSettled([
    app.auth.setAdminRole(app.login.token, app.admin.adminId, "admin"),
    other.auth.disableAdmin(login.token, second.adminId),
  ])
  assert.equal(results.filter((item) => item.status === "fulfilled").length, 1)
  assert.ok(code("last-superadmin")(results.find((item) => item.status === "rejected").reason))
  assert.equal(
    [...app.database.rows.get(ACCOUNTS).values()].filter(
      (row) => row.role === "superadmin" && row.enabled,
    ).length,
    1,
  )
})

test("密码计算期间被降级的普通管理员不能提交已开始的创建请求", async (t) => {
  const app = await actors(t)
  let checked = false
  app.database.beforeExecute = async (op) => {
    if (op.type === "get" && op.table === ACCOUNTS && op.key === app.manager.adminId) {
      checked = true
    }
  }
  const outcome = app.auth
    .createAdmin(app.managerLogin.token, { ...ROOT, loginName: "pending" })
    .then(
      () => "unexpected",
      (error) => error.code,
    )
  while (!checked) {
    await new Promise(setImmediate)
  }
  await app.auth.setAdminRole(app.login.token, app.manager.adminId, "viewer")
  assert.equal(await outcome, "unauthenticated")
  assert.equal(
    [...app.database.rows.get(ACCOUNTS).values()].some((row) => row.login_name === "pending"),
    false,
  )
})

test("等级变更审计失败回滚角色和会话撤销", async (t) => {
  const app = await actors(t)
  app.database.beforeExecute = async (op) => {
    if (op.type === "insert" && op.table === EVENTS && op.value.action === "set-role") {
      throw new Error("audit unavailable")
    }
  }
  await assert.rejects(
    app.auth.setAdminRole(app.login.token, app.manager.adminId, "viewer"),
    /audit unavailable/,
  )
  assert.equal((await app.auth.authenticate(app.managerLogin.token)).admin.role, "admin")
})

test("旧 schema 和不合法存储角色拒绝使用，不默认提升权限", async (t) => {
  const schema = structuredClone(adminAuthRelationalSchema)
  delete schema.tables[ACCOUNTS].columns.role
  await assert.rejects(setup({}, new MemoryDatabase(schema)), code("schema-mismatch"))
  const app = await signedIn()
  t.after(() => app.dispose())
  app.database.rows.get(ACCOUNTS).get(app.admin.adminId).role = "unknown"
  await assert.rejects(app.auth.authenticate(app.login.token), code("schema-mismatch"))
})
