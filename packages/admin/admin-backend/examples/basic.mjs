/* global console, fetch */
import { Context } from "cordis"
import { ToyStorage } from "toy-storage"
import { RelationalStorage } from "toy-storage-relational"
import { HttpServer } from "toy-backend-http"
import { Admin, adminRelationalSchema } from "toy-admin"
import { AdminAuth, adminAuthRelationalSchema } from "toy-admin-auth"
import { AdminBackendService, httpBinding } from "../lib/index.js"
import { MemoryDatabase } from "../../admin-auth/test/helpers.mjs"

const schema = { tables: { ...adminAuthRelationalSchema.tables, ...adminRelationalSchema.tables } }
const PASSWORD = "a strong password 123!"
const ROOT = { loginName: "owner", password: PASSWORD }

const ctx = new Context()
try {
  await ctx.plugin(ToyStorage)
  await ctx.plugin(RelationalStorage)
  ctx.storage.register("relational", "main", new MemoryDatabase(schema))
  await ctx.plugin(AdminAuth)
  await ctx.plugin(Admin)
  await ctx.plugin(HttpServer, { host: "127.0.0.1", port: 0 })
  await ctx.plugin(AdminBackendService)
  await ctx.http.ready

  // 宿主初始化首个管理员（bootstrap 不暴露为 HTTP 路由）
  await ctx.adminAuth.bootstrap(ROOT)

  // 业务插件注册一个运维能力；路径自动挂到 /admin 前缀下
  ctx.effect(() =>
    ctx.admin.register({
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
      execute: (input) => ({ doubled: input.value * 2 }),
    }),
  )

  const base = `http://127.0.0.1:${ctx.http.address().port}`
  console.log("admin backend listening on", base)
  console.log("  POST /admin/login")
  console.log("  POST /admin/example/double  (动态能力路由)")

  // 自检：登录 → 调用能力
  const login = await (
    await fetch(`${base}/admin/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(ROOT),
    })
  ).json()
  const token = login.data.token
  console.log("登录成功，凭据不写入日志")

  const result = await (
    await fetch(`${base}/admin/example/double`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ value: 21 }),
    })
  ).json()
  console.log("调用 /admin/example/double {value:21} ->", JSON.stringify(result))

  const unauth = await fetch(`${base}/admin/example/double`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ value: 1 }),
  })
  console.log("无 token 调用 ->", unauth.status)

  console.log("绑定诊断数量：", ctx.adminBackend.getBindingIssues().length)
} finally {
  // 示例自检后关闭本机随机端口；任务和网络生命周期仍由各自所属层管理。
  if (ctx.admin) {
    ctx.admin.stop()
    await ctx.admin.waitForIdle({ timeoutMs: 2000 })
  }
  await ctx.fiber.dispose()
}
