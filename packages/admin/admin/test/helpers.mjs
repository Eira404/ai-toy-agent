/* global structuredClone */
import { Context, Service } from "cordis"
import { ToyStorage } from "toy-storage"
import { RelationalStorage } from "toy-storage-relational"
import { AdminAuth, AdminAuthError, adminAuthRelationalSchema } from "toy-admin-auth"
import { MemoryDatabase } from "../../admin-auth/test/helpers.mjs"
import { Admin, adminRelationalSchema, ADMIN_OPERATIONS_TABLE } from "../lib/index.js"

export const schema = {
  tables: { ...adminAuthRelationalSchema.tables, ...adminRelationalSchema.tables },
}

/** 认证测试替身只用于快速验证总包边界；集成用例和 example 使用真实 AdminAuth。 */
export class FakeAdminAuth extends Service {
  constructor(ctx) {
    super(ctx, "adminAuth")
    this.identities = new Map(
      ["superadmin", "admin", "viewer"].map((role) => [
        role,
        {
          admin: {
            adminId: `id-${role}`,
            loginName: role,
            displayName: role,
            role,
            enabled: true,
            createdAt: "2026-11-14T00:00:00.000Z",
            updatedAt: "2026-11-14T00:00:00.000Z",
            passwordChangedAt: "2026-11-14T00:00:00.000Z",
          },
          sessionId: `session-${role}`,
          expiresAt: "2099-01-01T00:00:00.000Z",
        },
      ]),
    )
    this.calls = 0
  }

  async authenticate(token) {
    this.calls++
    await this.beforeAuthenticate?.(token, this.calls)
    const identity = this.identities.get(token)
    if (!identity) {
      throw new AdminAuthError("unauthenticated", "invalid token")
    }
    return structuredClone(identity)
  }
}

export async function setup(
  config = {},
  { realAuth = false, database = new MemoryDatabase(schema) } = {},
) {
  const ctx = new Context()
  const fibers = []
  try {
    fibers.push(await ctx.plugin(ToyStorage))
    fibers.push(await ctx.plugin(RelationalStorage))
    ctx.storage.register("relational", "main", database)
    fibers.push(await ctx.plugin(realAuth ? AdminAuth : FakeAdminAuth))
    fibers.push(await ctx.plugin(Admin, config))
    const app = {
      ctx,
      admin: ctx.admin,
      auth: ctx.adminAuth,
      database,
      audits: () => [...database.rows.get(ADMIN_OPERATIONS_TABLE).values()],
      async dispose() {
        app.admin.stop()
        await app.admin.waitForIdle({ timeoutMs: 2000 })
        for (const fiber of fibers.reverse()) {
          await fiber.dispose()
        }
      },
    }
    return app
  } catch (error) {
    for (const fiber of fibers.reverse()) {
      await fiber.dispose()
    }
    throw error
  }
}

export function operation(overrides = {}) {
  return {
    name: "example.echo",
    description: "示例能力，无运维副作用",
    roles: ["superadmin", "admin", "viewer"],
    kind: "query",
    bindings: [{ transport: "http", method: "POST", path: "/example/echo" }],
    input: {
      type: "object",
      properties: { value: { type: "integer" } },
      required: ["value"],
      additionalProperties: false,
    },
    output: {
      type: "object",
      properties: { value: { type: "integer" } },
      required: ["value"],
      additionalProperties: false,
    },
    execute: (input) => ({ value: input.value }),
    ...overrides,
  }
}

export function gate() {
  let resolve
  let reject
  const promise = new Promise((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

export { MemoryDatabase }
