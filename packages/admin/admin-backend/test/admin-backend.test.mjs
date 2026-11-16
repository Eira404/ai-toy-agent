/* global fetch, setTimeout */
import assert from "node:assert/strict"
import test from "node:test"
import { Context } from "cordis"
import { ToyStorage } from "toy-storage"
import { RelationalStorage } from "toy-storage-relational"
import { HttpServer } from "toy-backend-http"
import { Admin, adminRelationalSchema } from "toy-admin"
import { AdminAuth, adminAuthRelationalSchema } from "toy-admin-auth"
import { MemoryDatabase } from "../../admin-auth/test/helpers.mjs"
import { AdminBackendService, httpBinding } from "../lib/index.js"

const schema = {
  tables: { ...adminAuthRelationalSchema.tables, ...adminRelationalSchema.tables },
}
const PASSWORD = "a strong password 123!"
const ROOT = { loginName: "root", password: PASSWORD }

async function makeBackend(config = {}) {
  const ctx = new Context()
  await ctx.plugin(ToyStorage)
  await ctx.plugin(RelationalStorage)
  ctx.storage.register("relational", "main", new MemoryDatabase(schema))
  await ctx.plugin(AdminAuth)
  await ctx.plugin(Admin)
  await ctx.plugin(HttpServer, { port: 0 })
  await ctx.plugin(AdminBackendService, config)
  await ctx.http.ready
  return ctx
}

async function postJson(url, body, token) {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify(body),
  })
  return { status: res.status, json: await res.json() }
}

function doubleOperation() {
  return {
    name: "example.double",
    description: "返回输入的两倍",
    roles: ["superadmin", "admin"],
    kind: "query",
    bindings: [httpBinding({ method: "POST", path: "/example/double" })],
    input: {
      type: "object",
      properties: { value: { type: "integer" } },
      required: ["value"],
      additionalProperties: false,
    },
    output: {
      type: "object",
      properties: { doubled: { type: "integer" } },
      required: ["doubled"],
      additionalProperties: false,
    },
    execute: (input) => ({ doubled: input.value * 2 }),
  }
}

test("登录端点 + 动态能力路由 + 鉴权 + 注销", async () => {
  const ctx = await makeBackend()
  const base = `http://127.0.0.1:${ctx.http.address().port}`

  try {
    // 宿主初始化首个管理员（bootstrap 不暴露为 HTTP）
    await ctx.adminAuth.bootstrap(ROOT)

    // 匿名登录端点
    const login = await postJson(`${base}/admin/login`, ROOT)
    assert.equal(login.status, 200)
    const token = login.json.data.token
    assert.equal(typeof token, "string")

    // 注册能力后应自动生成 /admin/example/double 路由
    const dispose = ctx.admin.register(doubleOperation())

    // 带 token 调用
    const ok = await postJson(`${base}/admin/example/double`, { value: 21 }, token)
    assert.equal(ok.status, 200)
    assert.deepEqual(ok.json, { ok: true, data: { doubled: 42 } })

    // 无 token → 401
    const unauth = await postJson(`${base}/admin/example/double`, { value: 1 })
    assert.equal(unauth.status, 401)
    assert.equal(unauth.json.error.code, "unauthenticated")

    // viewer 角色不在白名单 → 403
    await ctx.adminAuth.createAdmin(token, {
      loginName: "viewer",
      password: PASSWORD,
      role: "viewer",
    })
    const viewerLogin = await postJson(`${base}/admin/login`, {
      loginName: "viewer",
      password: PASSWORD,
    })
    const viewerToken = viewerLogin.json.data.token
    const forbidden = await postJson(`${base}/admin/example/double`, { value: 1 }, viewerToken)
    assert.equal(forbidden.status, 403)
    assert.equal(forbidden.json.error.code, "forbidden")

    // 注销能力后路由消失 → 404
    dispose()
    await new Promise((resolve) => setTimeout(resolve, 20))
    const gone = await postJson(`${base}/admin/example/double`, { value: 1 }, token)
    assert.equal(gone.status, 404)
  } finally {
    await ctx.fiber.dispose()
  }
})

async function signedBackend(t, config = {}) {
  const ctx = await makeBackend(config)
  t.after(async () => {
    ctx.admin.stop()
    await ctx.admin.waitForIdle({ timeoutMs: 2000 })
    await ctx.fiber.dispose()
  })
  await ctx.adminAuth.bootstrap(ROOT)
  const login = await ctx.adminAuth.login(ROOT)
  return { ctx, token: login.token, base: `http://127.0.0.1:${ctx.http.address().port}` }
}

test("GET 查询串、PATCH JSON 与显式 request 参数各按声明映射", async (t) => {
  const { ctx, base, token } = await signedBackend(t, { mountPath: "/manage/" })
  ctx.admin.register({
    ...doubleOperation(),
    name: "example.query",
    input: true,
    output: true,
    bindings: [httpBinding({ method: "GET", path: "/query" })],
    execute: (input) => input,
  })
  const get = await fetch(`${base}/manage/query?tag=a&tag=b&value=2&__proto__=safe`, {
    headers: { authorization: `Bearer ${token}` },
  })
  const query = await get.json()
  assert.equal(get.status, 200)
  assert.equal(query.data.value, "2")
  assert.deepEqual(query.data.tag, ["a", "b"])
  assert.equal(query.data.__proto__, "safe")
  ctx.admin.register({
    ...doubleOperation(),
    name: "example.patch",
    input: true,
    output: true,
    bindings: [httpBinding({ method: "PATCH", path: "/items/:id", inputSource: "request" })],
    execute: (input) => input,
  })
  const patch = await fetch(`${base}/manage/items/real-id?tag=a&tag=b`, {
    method: "PATCH",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ id: "body-id", value: 3 }),
  })
  const request = await patch.json()
  assert.equal(patch.status, 200)
  assert.deepEqual(request.data, {
    params: { id: "real-id" },
    query: { tag: ["a", "b"] },
    body: { id: "body-id", value: 3 },
  })
})

test("手写无效绑定、SSE、opaque 和 GET command 明确诊断，合法绑定继续工作", async (t) => {
  const { ctx, base, token } = await signedBackend(t)
  const invalid = [
    {
      name: "bad.sse",
      bindings: [{ transport: "http", method: "GET", path: "/bad-sse", responseMode: "sse" }],
    },
    {
      name: "bad.typo",
      bindings: [{ transport: "http", method: "POST", path: "/bad-typo", inputSouce: "body" }],
    },
    {
      name: "bad.command",
      kind: "command",
      bindings: [httpBinding({ method: "GET", path: "/bad-command" })],
    },
    {
      name: "bad.opaque",
      resultKind: "opaque",
      output: undefined,
      bindings: [httpBinding({ method: "GET", path: "/bad-opaque" })],
    },
  ]
  for (const override of invalid) {
    ctx.admin.register({ ...doubleOperation(), ...override })
  }
  ctx.admin.register(doubleOperation())
  const issues = ctx.adminBackend.getBindingIssues()
  assert.equal(issues.length, 4)
  assert.ok(Object.isFrozen(issues))
  assert.ok(issues.find((issue) => issue.operationName === "bad.sse").message.includes("SSE"))
  assert.equal(
    issues.find((issue) => issue.operationName === "bad.opaque").code,
    "unsupported-result",
  )
  assert.equal((await postJson(`${base}/admin/example/double`, { value: 2 }, token)).status, 200)
  const unsupported = await fetch(`${base}/admin/bad-sse`, {
    headers: { authorization: `Bearer ${token}` },
  })
  assert.equal(unsupported.status, 404)
})

test("重复和重叠路由拒绝双方，注销冲突项后自动恢复合法绑定", async (t) => {
  const { ctx, base, token } = await signedBackend(t)
  ctx.admin.register(doubleOperation())
  const dispose = ctx.admin.register({
    ...doubleOperation(),
    name: "example.collision",
    bindings: [{ transport: "http", method: "POST", path: "/example/double/" }],
  })
  assert.equal((await postJson(`${base}/admin/example/double`, { value: 2 }, token)).status, 404)
  assert.equal(
    ctx.adminBackend.getBindingIssues().filter((issue) => issue.code === "route-conflict").length,
    2,
  )
  dispose()
  assert.equal((await postJson(`${base}/admin/example/double`, { value: 2 }, token)).status, 200)
  assert.equal(ctx.adminBackend.getBindingIssues().length, 0)
})

test("固定认证路径及其参数模式保留，动态能力不能覆盖登录或账号接口", async (t) => {
  const { ctx, base } = await signedBackend(t)
  let effects = 0
  for (const [index, binding] of [
    httpBinding({ method: "POST", path: "/login" }),
    httpBinding({ method: "GET", path: "/admins/:name", inputSource: "request" }),
    httpBinding({ method: "GET", path: "/admins/count" }),
  ].entries()) {
    ctx.admin.register({
      ...doubleOperation(),
      name: `reserved.case${index}`,
      bindings: [binding],
      execute: () => {
        effects++
        return { doubled: 0 }
      },
    })
  }
  assert.equal(
    ctx.adminBackend.getBindingIssues().filter((issue) => issue.code === "route-conflict").length,
    3,
  )
  assert.equal((await postJson(`${base}/admin/login`, ROOT)).status, 200)
  assert.equal(effects, 0)
})
