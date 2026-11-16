/* global console */
import { Service } from "cordis"
import { setup } from "../test/helpers.mjs"

/** 示范业务插件只注册能力，通过自己的 effect 注销；没有 HTTP 或运维副作用。 */
class ExamplePlugin extends Service {
  static inject = ["admin"]

  constructor(ctx) {
    super(ctx, "adminExample")
    ctx.effect(() =>
      ctx.admin.register({
        name: "example.double",
        description: "返回输入数值的两倍",
        roles: ["superadmin", "admin"],
        kind: "query",
        bindings: [{ transport: "http", method: "POST", path: "/example/double" }],
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
        audit: () => ({ sample: true }),
        execute: (input, context) => {
          console.log("执行身份：", context.identity.admin.loginName)
          return { doubled: input.value * 2 }
        },
      }),
    )
  }
}

// 真实 AdminAuth + 总包，数据库使用内存测试替身；不需要网络、.env 或真实用户数据。
const app = await setup({}, { realAuth: true })
const ownerInput = { loginName: "owner", password: "example strong password 123!" }
try {
  await app.auth.bootstrap(ownerInput)
  const owner = await app.auth.login(ownerInput)
  await app.auth.createAdmin(owner.token, { ...ownerInput, loginName: "reader" })
  const reader = await app.auth.login({ ...ownerInput, loginName: "reader" })
  const provider = await app.ctx.plugin(ExamplePlugin)
  console.log(
    "可见能力：",
    (await app.admin.listOperations(owner.token)).map((item) => item.name),
  )
  console.log(
    "调用结果：",
    await app.admin.execute("example.double", { token: owner.token, input: { value: 21 } }),
  )
  try {
    await app.admin.execute("example.double", { token: reader.token, input: { value: 1 } })
  } catch (error) {
    console.log("只读账号调用：", error.code)
  }
  console.log(
    "审计结果：",
    app.audits().map((row) => ({ operation: row.operation_name, status: row.status })),
  )
  await provider.dispose()
  console.log("提供插件卸载后能力数：", app.admin.getRegistrySnapshot().operations.length)
} finally {
  await app.dispose()
}
