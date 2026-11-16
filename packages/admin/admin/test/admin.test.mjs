/* global structuredClone, AbortController */
import assert from "node:assert/strict"
import test from "node:test"
import { Service } from "cordis"
import { RelationalError } from "toy-storage-relational"
import { AdminError, ADMIN_OPERATIONS_TABLE, adminRelationalSchema } from "../lib/index.js"
import { gate, operation, setup, MemoryDatabase, schema } from "./helpers.mjs"

const code = (expected) => (error) => error instanceof AdminError && error.code === expected
const call = (app, input = { value: 2 }, token = "admin", extra = {}) =>
  app.admin.execute("example.echo", { token, input, ...extra })

test("注册、分发、可信上下文、冻结 DTO 与默认安全审计", async (t) => {
  const app = await setup()
  t.after(() => app.dispose())
  let seen
  app.admin.register(
    operation({
      execute: (input, context) => {
        seen = context
        assert.ok(Object.isFrozen(input))
        return { value: input.value * 2 }
      },
    }),
  )
  assert.deepEqual(await call(app), { value: 4 })
  assert.equal(seen.identity.admin.role, "admin")
  assert.equal(seen.token, undefined)
  assert.ok(Object.isFrozen(seen.identity.admin))
  const audit = app.audits()[0]
  assert.equal(audit.execution_id, seen.executionId)
  assert.equal(audit.execution_state, "succeeded")
  assert.equal(audit.wait_status, "completed")
  assert.equal(audit.summary, null)
  assert.equal(JSON.stringify(audit).includes("session-admin"), false)
})

test("定义、Schema、函数均固定于注册时，公开快照无回调且不可修改", async (t) => {
  const app = await setup()
  t.after(() => app.dispose())
  const definition = operation()
  app.admin.register(definition)
  definition.roles.length = 0
  definition.bindings[0].path = "/modified"
  definition.input.properties.value.type = "string"
  definition.execute = () => {
    throw new Error("replacement")
  }
  const snapshot = app.admin.getRegistrySnapshot()
  assert.equal(snapshot.operations[0].bindings[0].path, "/example/echo")
  assert.equal(snapshot.operations[0].execute, undefined)
  assert.throws(() => snapshot.operations[0].roles.push("viewer"), TypeError)
  assert.deepEqual(await call(app), { value: 2 })
})

test("非法定义/远程引用/异步 Schema 均不改变注册表", async (t) => {
  const app = await setup()
  t.after(() => app.dispose())
  for (const overrides of [
    { name: "bad/name" },
    { roles: [] },
    { roles: ["owner"] },
    { kind: "command" },
    { bindings: [] },
    { bindings: [{ path: "/x" }] },
    { execute: null },
    { input: { type: "does-not-exist" } },
    { input: { $ref: "https://example.com/schema" } },
    { input: { $async: true, type: "object" } },
    { input: null },
    { resultKind: "opaque" },
    { timeoutMs: 999999999 },
  ]) {
    assert.throws(() => app.admin.register(operation(overrides)), AdminError)
  }
  assert.equal(app.admin.getRegistrySnapshot().revision, 0)
})

test("注册名唯一，注销幂等，旧 disposer 不删除同名新项，旧路由代次拒绝", async (t) => {
  const app = await setup()
  t.after(() => app.dispose())
  const dispose = app.admin.register(operation())
  const old = app.admin.getRegistrySnapshot().operations[0].registrationId
  assert.throws(() => app.admin.register(operation()), code("duplicate-operation"))
  dispose()
  dispose()
  app.admin.register(operation())
  dispose()
  await assert.rejects(
    call(app, { value: 2 }, "admin", { expectedRegistrationId: old }),
    code("operation-unavailable"),
  )
  assert.deepEqual(await call(app), { value: 2 })
})

test("插件卸载跟随 ctx.effect 注销能力，并发出的注册表通知与 revision 对齐", async (t) => {
  const app = await setup()
  t.after(() => app.dispose())
  const snapshots = []
  app.ctx.on("admin/operations-changed", (snapshot) => {
    snapshots.push(snapshot)
  })
  class Provider extends Service {
    static inject = ["admin"]
    constructor(ctx) {
      super(ctx, "exampleProvider")
      ctx.effect(() => ctx.admin.register(operation()))
    }
  }
  const fiber = await app.ctx.plugin(Provider)
  await call(app)
  await fiber.dispose()
  await assert.rejects(call(app), code("operation-not-found"))
  assert.deepEqual(
    snapshots.map((item) => item.revision),
    [1, 2],
  )
  assert.equal(snapshots[1].operations.length, 0)
})

test("角色过滤、认证优先于输入校验，超级管理员没有隐式白名单绕过", async (t) => {
  const app = await setup()
  t.after(() => app.dispose())
  let executions = 0
  app.admin.register(
    operation({
      roles: ["admin"],
      execute: () => {
        executions++
        return { value: 1 }
      },
    }),
  )
  assert.equal((await app.admin.listOperations("viewer")).length, 0)
  assert.equal((await app.admin.describeOperation("admin", "example.echo")).name, "example.echo")
  await assert.rejects(app.admin.describeOperation("viewer", "example.echo"), code("forbidden"))
  await assert.rejects(call(app, null, "missing"), code("unauthenticated"))
  await assert.rejects(call(app, null, "viewer"), code("forbidden"))
  await assert.rejects(call(app, { value: 1 }, "superadmin"), code("forbidden"))
  assert.equal(executions, 0)
  assert.deepEqual(
    app.audits().map((row) => row.error_code),
    ["unauthenticated", "forbidden", "forbidden"],
  )
})

test("输入不隐式转换、补默认值、删字段，拒绝循环/稀疏数组/非 JSON 对象", async (t) => {
  const app = await setup()
  t.after(() => app.dispose())
  app.admin.register(operation())
  const cycle = {}
  cycle.self = cycle
  for (const input of [
    { value: "2" },
    {},
    { value: 2, extra: true },
    { value: NaN },
    new Date(),
    cycle,
    Array(2),
  ]) {
    await assert.rejects(call(app, input), code("invalid-input"))
  }
  assert.ok(app.audits().every((row) => row.execution_state === "not-started"))
})

test("目标授权 false/throw 拒绝，审计和回调均在鉴权之后执行", async (t) => {
  const app = await setup()
  t.after(() => app.dispose())
  let audits = 0
  let executions = 0
  app.admin.register(
    operation({
      authorize: () => false,
      audit: () => {
        audits++
        return {}
      },
      execute: () => {
        executions++
      },
    }),
  )
  await assert.rejects(call(app), code("forbidden"))
  assert.equal(audits, 0)
  assert.equal(executions, 0)
})

test("前置异步授权期间凭据失效，重新认证阻止真正执行", async (t) => {
  const app = await setup()
  t.after(() => app.dispose())
  const entered = gate()
  const resume = gate()
  let executions = 0
  app.admin.register(
    operation({
      authorize: async () => {
        entered.resolve()
        await resume.promise
      },
      execute: () => {
        executions++
      },
    }),
  )
  const pending = call(app)
  await entered.promise
  app.auth.identities.delete("admin")
  resume.resolve()
  await assert.rejects(pending, code("unauthenticated"))
  assert.equal(executions, 0)
})

test("输出校验失败和普通异常安全包装，明确业务是否已运行", async (t) => {
  const app = await setup()
  t.after(() => app.dispose())
  let effects = 0
  const dispose = app.admin.register(
    operation({
      execute: () => {
        effects++
        return { value: "bad" }
      },
    }),
  )
  await assert.rejects(
    call(app),
    (error) => code("invalid-output")(error) && error.executionState === "succeeded",
  )
  dispose()
  app.admin.register(
    operation({
      execute: () => {
        throw new Error("SECRET-input-password")
      },
    }),
  )
  await assert.rejects(
    call(app),
    (error) =>
      code("execution-failed")(error) &&
      error.executionState === "failed" &&
      !error.message.includes("SECRET"),
  )
  assert.equal(effects, 1)
  assert.equal(JSON.stringify(app.audits()).includes("SECRET"), false)
})

test("安全摘要显式白名单；默认不保存正文，敏感键和过大摘要拒绝执行", async (t) => {
  const app = await setup({ maxAuditBytes: 30 })
  t.after(() => app.dispose())
  const dispose = app.admin.register(operation({ audit: (input) => ({ count: input.value }) }))
  await call(app)
  assert.deepEqual(app.audits()[0].summary, { count: 2 })
  dispose()
  for (const summary of [{ nested: { accessToken: "secret" } }, { text: "x".repeat(100) }]) {
    const remove = app.admin.register(
      operation({
        audit: () => summary,
        execute: () => {
          throw new Error("must not execute")
        },
      }),
    )
    await assert.rejects(call(app), code("audit-unavailable"))
    remove()
  }
  assert.equal(JSON.stringify(app.audits()).includes("secret"), false)
})

test("开始审计失败绝不执行；结束审计失败报告实际业务状态且不重试", async (t) => {
  const app = await setup()
  t.after(() => app.dispose())
  let effects = 0
  app.admin.register(
    operation({
      execute: () => {
        effects++
        return { value: 1 }
      },
    }),
  )
  app.database.beforeExecute = async (op) => {
    if (op.type === "insert" && op.table === ADMIN_OPERATIONS_TABLE) {
      throw new Error("database offline")
    }
  }
  await assert.rejects(
    call(app),
    (error) => code("audit-unavailable")(error) && error.executionState === "not-started",
  )
  assert.equal(effects, 0)
  app.database.beforeExecute = async (op) => {
    if (op.type === "update" && op.table === ADMIN_OPERATIONS_TABLE) {
      throw new Error("database offline")
    }
  }
  await assert.rejects(
    call(app),
    (error) =>
      code("audit-incomplete")(error) &&
      error.executionState === "succeeded" &&
      typeof error.executionId === "string",
  )
  assert.equal(effects, 1)
  assert.equal(app.audits()[0].status, "running")
})

test("opaque 原样交付事件源，不消费、不等待后续任务或网络连接", async (t) => {
  const app = await setup()
  t.after(() => app.dispose())
  let consumed = 0
  const source = {
    async *[Symbol.asyncIterator]() {
      consumed++
      yield { progress: 1 }
    },
  }
  app.admin.register(operation({ resultKind: "opaque", output: undefined, execute: () => source }))
  assert.equal(await call(app), source)
  await app.admin.waitForIdle({ timeoutMs: 50 })
  assert.equal(consumed, 0)
})

test("绑定只是元数据，总包不校验协议 URL 冲突，也不创建端口", async (t) => {
  const app = await setup()
  t.after(() => app.dispose())
  app.admin.register(operation())
  app.admin.register(
    operation({ name: "example.other", bindings: [{ transport: "custom", route: "anything" }] }),
  )
  app.admin.register(operation({ name: "example.same-path" }))
  assert.equal(app.admin.getRegistrySnapshot().operations.length, 3)
})

test("超时只结束等待，忽略取消的业务仍占并发容量并最终记账", async (t) => {
  const app = await setup({ defaultTimeoutMs: 40, maxConcurrentExecutions: 1 })
  t.after(() => app.dispose())
  const entered = gate()
  const release = gate()
  app.admin.register(
    operation({
      execute: async () => {
        entered.resolve()
        await release.promise
        return { value: 1 }
      },
    }),
  )
  const pending = call(app)
  const rejected = assert.rejects(
    pending,
    (error) => code("timeout")(error) && error.executionState === "unknown",
  )
  await entered.promise
  await rejected
  await assert.rejects(call(app), code("busy"))
  await assert.rejects(app.admin.waitForIdle({ timeoutMs: 10 }), code("timeout"))
  release.resolve()
  await app.admin.waitForIdle({ timeoutMs: 1000 })
  const completed = app.audits().find((row) => row.status === "succeeded")
  assert.equal(completed.wait_status, "timeout")
  assert.equal(completed.execution_state, "succeeded")
})

test("外部取消与注销传递信号，不把请求取消误认为已回滚", async (t) => {
  const app = await setup()
  t.after(() => app.dispose())
  let signal
  const entered = gate()
  const release = gate()
  const dispose = app.admin.register(
    operation({
      execute: async (_input, context) => {
        signal = context.signal
        entered.resolve()
        await release.promise
        return { value: 1 }
      },
    }),
  )
  const controller = new AbortController()
  const pending = call(app, { value: 2 }, "admin", { signal: controller.signal })
  const rejected = assert.rejects(pending, code("cancelled"))
  await entered.promise
  controller.abort("SECRET-reason")
  await rejected
  assert.equal(signal.aborted, true)
  dispose()
  release.resolve()
  await app.admin.waitForIdle({ timeoutMs: 1000 })
  assert.equal(app.audits()[0].execution_state, "succeeded")
})

test("注销发生在前置授权等待时，不再启动业务", async (t) => {
  const app = await setup()
  t.after(() => app.dispose())
  const entered = gate()
  const release = gate()
  let effects = 0
  const dispose = app.admin.register(
    operation({
      authorize: async () => {
        entered.resolve()
        await release.promise
      },
      execute: () => {
        effects++
      },
    }),
  )
  const pending = call(app)
  const rejected = assert.rejects(pending, code("cancelled"))
  await entered.promise
  dispose()
  await rejected
  release.resolve()
  await app.admin.waitForIdle({ timeoutMs: 1000 })
  assert.equal(effects, 0)
})

test("stop 后拒绝新调用，waitForIdle 不取消执行，旧服务引用卸载后拒绝使用", async () => {
  const app = await setup()
  app.admin.register(operation())
  app.admin.stop()
  await assert.rejects(call(app), code("operation-unavailable"))
  await app.dispose()
  await assert.rejects(call(app), code("operation-unavailable"))
})

test("缺少审计表声明拒绝初始化，大小和信号参数限制有效", async (t) => {
  const broken = structuredClone(schema)
  delete broken.tables[ADMIN_OPERATIONS_TABLE]
  await assert.rejects(setup({}, { database: new MemoryDatabase(broken) }), code("schema-mismatch"))
  const app = await setup({ maxDataBytes: 12 })
  t.after(() => app.dispose())
  app.admin.register(operation())
  await assert.rejects(call(app, { value: 1234567890123 }), code("invalid-input"))
  await assert.rejects(call(app, { value: 1 }, "admin", { signal: {} }), code("invalid-input"))
  assert.equal(adminRelationalSchema.tables[ADMIN_OPERATIONS_TABLE].primaryKey, "execution_id")
})

test("调用选项异步期间被替换时仍使用原凭据，名称上下文与实际分发一致", async (t) => {
  const app = await setup()
  t.after(() => app.dispose())
  const entered = gate()
  const release = gate()
  let who
  app.auth.beforeAuthenticate = async (_token, count) => {
    if (count === 1) {
      entered.resolve()
      await release.promise
    }
  }
  app.admin.register(
    operation({
      execute: (input, context) => {
        who = context.identity.admin.role
        assert.equal(context.operationName, "example.echo")
        return { value: input.value }
      },
    }),
  )
  const options = { token: "admin", input: { value: 2 } }
  const pending = app.admin.execute(" example.echo ", options)
  await entered.promise
  options.token = "viewer"
  options.input = { value: 99 }
  release.resolve()
  assert.deepEqual(await pending, { value: 2 })
  assert.equal(who, "admin")
  assert.equal(app.audits()[0].operation_name, "example.echo")
})

test("未知数据库提交状态保留 unknown，不能推断业务失败或安全重试", async (t) => {
  const app = await setup()
  t.after(() => app.dispose())
  app.admin.register(
    operation({
      execute: () => {
        throw new RelationalError("unknown-commit-state", "database commit uncertain")
      },
    }),
  )
  await assert.rejects(
    call(app),
    (error) => code("execution-failed")(error) && error.executionState === "unknown",
  )
  assert.equal(app.audits()[0].execution_state, "unknown")
})

test("预取消请求不执行；等待空闲取消不会影响现有业务", async (t) => {
  const app = await setup()
  t.after(() => app.dispose())
  let effects = 0
  app.admin.register(
    operation({
      execute: () => {
        effects++
        return { value: 1 }
      },
    }),
  )
  const signal = new AbortController()
  signal.abort()
  await assert.rejects(
    call(app, { value: 1 }, "admin", { signal: signal.signal }),
    code("cancelled"),
  )
  await app.admin.waitForIdle({ timeoutMs: 1000 })
  assert.equal(effects, 0)
  await assert.rejects(app.admin.waitForIdle({ signal: signal.signal }), code("cancelled"))
  await assert.rejects(app.admin.waitForIdle(null), code("invalid-input"))
})

test("结束审计等待期间超时也补记等待状态，业务状态保持成功", async (t) => {
  const app = await setup({ defaultTimeoutMs: 40 })
  t.after(() => app.dispose())
  const entered = gate()
  const release = gate()
  let held = false
  app.database.beforeExecute = async (op) => {
    if (!held && op.type === "update" && op.table === ADMIN_OPERATIONS_TABLE) {
      held = true
      entered.resolve()
      await release.promise
    }
  }
  app.admin.register(operation())
  const pending = call(app)
  const rejected = assert.rejects(
    pending,
    (error) => code("timeout")(error) && error.executionState === "succeeded",
  )
  await entered.promise
  await rejected
  release.resolve()
  await app.admin.waitForIdle({ timeoutMs: 1000 })
  assert.equal(app.audits()[0].wait_status, "timeout")
  assert.equal(app.audits()[0].execution_state, "succeeded")
})

test("迟到的业务拒绝仍被观察、释放容量并完成审计", async (t) => {
  const app = await setup({ defaultTimeoutMs: 40 })
  t.after(() => app.dispose())
  const entered = gate()
  const release = gate()
  app.admin.register(
    operation({
      execute: async () => {
        entered.resolve()
        await release.promise
        throw new Error("late error")
      },
    }),
  )
  const pending = call(app)
  const rejected = assert.rejects(pending, code("timeout"))
  await entered.promise
  await rejected
  release.resolve()
  await app.admin.waitForIdle({ timeoutMs: 1000 })
  assert.equal(app.audits()[0].execution_state, "failed")
  assert.equal(app.audits()[0].wait_status, "timeout")
})

test("真实 admin-auth 集成：角色变更撤销会话，总包随当前角色授权", async (t) => {
  const app = await setup({}, { realAuth: true })
  t.after(() => app.dispose())
  const credentials = { loginName: "owner", password: "example secure password 123!" }
  await app.auth.bootstrap(credentials)
  const owner = await app.auth.login(credentials)
  const viewer = await app.auth.createAdmin(owner.token, { ...credentials, loginName: "reader" })
  let login = await app.auth.login({ ...credentials, loginName: "reader" })
  app.admin.register(operation({ roles: ["superadmin", "admin"] }))
  await assert.rejects(call(app, { value: 1 }, login.token), code("forbidden"))
  await app.auth.setAdminRole(owner.token, viewer.adminId, "admin")
  await assert.rejects(call(app, { value: 1 }, login.token), code("unauthenticated"))
  login = await app.auth.login({ ...credentials, loginName: "reader" })
  assert.deepEqual(await call(app, { value: 1 }, login.token), { value: 1 })
})
