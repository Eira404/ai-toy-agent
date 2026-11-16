import { Service, type Context } from "cordis"
import "toy-admin-auth"
import "toy-backend-http"
import { AdminError, type AdminOperationDescription, type AdminRegistrySnapshot } from "toy-admin"
import type { AdminRole, ChangePasswordInput, CreateAdminInput, LoginInput } from "toy-admin-auth"
import type { HttpContext, HttpHandler } from "toy-backend-http"
import { resolveAdminBackendConfig } from "./config.js"
import { parseHttpBinding, routesOverlap } from "./binding.js"
import type { AdminBackendConfig, AdminHttpBinding, AdminBindingIssue } from "./types.js"

declare module "cordis" {
  interface Context {
    adminBackend: AdminBackendService
  }
}

/**
 * 管理员 HTTP 后端：把 `toy-admin` 注册的能力与 `toy-admin-auth` 的账号接口挂载到
 * `toy-backend-http`。固定账号端点与动态能力路由统一挂在 mountPath（默认 `/admin`）下。
 */
export class AdminBackendService extends Service {
  static inject = ["http", "admin", "adminAuth"]

  private readonly mountPath: string
  private readonly capabilityDisposers = new Map<string, () => void>()
  private revision = -1
  private readonly authRoutes: { method: string; path: string }[] = []
  private bindingIssues: readonly AdminBindingIssue[] = Object.freeze([])

  constructor(ctx: Context, config: AdminBackendConfig = {}) {
    super(ctx, "adminBackend")
    this.mountPath = resolveAdminBackendConfig(config).mountPath

    ctx.effect(() => {
      const authDisposers = this.registerAuthRoutes()
      this.resyncCapabilities(this.ctx.admin.getRegistrySnapshot())
      const off = ctx.on("admin/operations-changed", (snapshot) => {
        this.resyncCapabilities(snapshot)
      })
      return () => {
        off()
        for (const dispose of authDisposers) {
          dispose()
        }
        this.disposeCapabilities()
        this.authRoutes.length = 0
        this.bindingIssues = Object.freeze([])
        this.revision = -1
      }
    }, "adminBackend.routes")
  }

  /** 返回最新快照未挂载的 HTTP 绑定原因，供可信宿主诊断，不暴露请求/凭据。 */
  getBindingIssues(): readonly AdminBindingIssue[] {
    return this.bindingIssues
  }

  /** 固定账号/认证端点，直接调用 adminAuth，不走能力注册表。 */
  private registerAuthRoutes(): (() => void)[] {
    const { adminAuth } = this.ctx
    // 从真正注册的端点收集保留路由，不维护另一份易漂移的账号路径常量。
    const register = (method: string, path: string, handler: HttpHandler): (() => void) => {
      const dispose = this.ctx.http.route(method, path, handler)
      this.authRoutes.push({ method, path })
      return dispose
    }
    const http = {
      get: (path: string, handler: HttpHandler) => register("GET", path, handler),
      post: (path: string, handler: HttpHandler) => register("POST", path, handler),
    }
    const p = this.mountPath
    const routes: (() => void)[] = []
    const withToken = (handler: (token: string, c: HttpContext) => unknown): HttpHandler => {
      return (c) => handler(extractToken(c), c)
    }

    // 匿名登录
    routes.push(http.post(`${p}/login`, (c) => adminAuth.login(c.body as LoginInput)))
    // 自助安全
    routes.push(
      http.post(
        `${p}/logout`,
        withToken((token) => adminAuth.logout(token)),
      ),
    )
    routes.push(
      http.get(
        `${p}/me`,
        // /me 返回会话身份，与登录响应和 API 文档保持一致。
        withToken((token) => adminAuth.authenticate(token)),
      ),
    )
    routes.push(
      http.post(
        `${p}/change-password`,
        withToken((token, c) => adminAuth.changePassword(token, c.body as ChangePasswordInput)),
      ),
    )
    routes.push(
      http.post(
        `${p}/revoke-my-sessions`,
        withToken((token) => adminAuth.revokeMySessions(token)),
      ),
    )
    // 账号管理
    routes.push(
      http.post(
        `${p}/admins`,
        withToken((token, c) => adminAuth.createAdmin(token, c.body as CreateAdminInput)),
      ),
    )
    routes.push(
      http.get(
        `${p}/admins`,
        withToken((token, c) => adminAuth.listAdmins(token, listAdminsInput(c))),
      ),
    )
    routes.push(
      http.get(
        `${p}/admins/:adminId`,
        withToken((token, c) => adminAuth.getAdmin(token, c.params.adminId!)),
      ),
    )
    routes.push(
      http.post(
        `${p}/admins/:adminId/disable`,
        withToken((token, c) => adminAuth.disableAdmin(token, c.params.adminId!)),
      ),
    )
    routes.push(
      http.post(
        `${p}/admins/:adminId/enable`,
        withToken((token, c) => adminAuth.enableAdmin(token, c.params.adminId!)),
      ),
    )
    routes.push(
      http.post(
        `${p}/admins/:adminId/role`,
        withToken((token, c) => adminAuth.setAdminRole(token, c.params.adminId!, roleOf(c.body))),
      ),
    )
    routes.push(
      http.post(
        `${p}/admins/:adminId/revoke-sessions`,
        withToken((token, c) => adminAuth.revokeAdminSessions(token, c.params.adminId!)),
      ),
    )
    routes.push(
      http.post(
        `${p}/sessions/cleanup`,
        withToken((token, c) => adminAuth.cleanupExpiredSessions(token, cleanupLimit(c.body))),
      ),
    )
    return routes
  }

  /** 全量验证再对齐路由；冲突双方都不挂载，避免按注册顺序选择执行者。 */
  private resyncCapabilities(snapshot: AdminRegistrySnapshot): void {
    if (snapshot.revision <= this.revision) {
      return
    }
    const issues: AdminBindingIssue[] = []
    const candidates: {
      key: string
      operation: AdminOperationDescription
      binding: AdminHttpBinding
      index: number
      method: string
      path: string
    }[] = []
    const report = (
      operation: AdminOperationDescription,
      bindingIndex: number,
      code: AdminBindingIssue["code"],
      message: string,
    ): void => {
      issues.push(
        Object.freeze({
          operationName: operation.name,
          registrationId: operation.registrationId,
          bindingIndex,
          code,
          message,
        }),
      )
    }
    for (const operation of snapshot.operations) {
      operation.bindings.forEach((raw, index) => {
        try {
          const binding = parseHttpBinding(raw)
          if (binding === undefined) {
            return
          }
          if (operation.resultKind !== "value") {
            report(
              operation,
              index,
              "unsupported-result",
              "当前 HTTP JSON 适配器不接收 opaque 结果",
            )
            return
          }
          if (binding.method === "GET" && operation.kind !== "query") {
            report(operation, index, "invalid-binding", "GET 只能绑定 query 能力")
            return
          }
          const path = joinPath(this.mountPath, binding.path)
          if (
            this.authRoutes.some((route) => routesOverlap(route, { method: binding.method, path }))
          ) {
            report(operation, index, "route-conflict", "能力路径与固定账号端点重叠")
            return
          }
          candidates.push({
            key: capabilityKey(operation, binding),
            operation,
            binding,
            index,
            method: binding.method,
            path,
          })
        } catch (error) {
          report(
            operation,
            index,
            "invalid-binding",
            error instanceof AdminError ? error.message : "HTTP 绑定无法解析",
          )
        }
      })
    }
    const conflicted = new Set<string>()
    for (let i = 0; i < candidates.length; i++) {
      for (let j = i + 1; j < candidates.length; j++) {
        if (routesOverlap(candidates[i]!, candidates[j]!)) {
          conflicted.add(candidates[i]!.key)
          conflicted.add(candidates[j]!.key)
        }
      }
    }
    const desired = new Map<string, (typeof candidates)[number]>()
    for (const candidate of candidates) {
      if (conflicted.has(candidate.key)) {
        report(
          candidate.operation,
          candidate.index,
          "route-conflict",
          "管理能力之间存在重复或重叠的 HTTP 路由",
        )
      } else {
        desired.set(candidate.key, candidate)
      }
    }
    // 先移除旧定义/冲突路由，再挂载本次合法绑定。整个同步过程没有异步执行窗口。
    for (const [key, dispose] of this.capabilityDisposers) {
      if (!desired.has(key)) {
        dispose()
        this.capabilityDisposers.delete(key)
      }
    }
    for (const [key, candidate] of desired) {
      if (!this.capabilityDisposers.has(key)) {
        this.capabilityDisposers.set(
          key,
          this.registerCapabilityRoute(candidate.operation, candidate.binding),
        )
      }
    }
    this.bindingIssues = Object.freeze(issues)
    this.revision = snapshot.revision
    for (const issue of issues) {
      this.ctx.logger.warn(
        "管理能力 %s 的绑定 %s 未挂载：%s",
        issue.operationName,
        issue.bindingIndex,
        issue.message,
      )
    }
  }

  private registerCapabilityRoute(
    operation: AdminOperationDescription,
    binding: AdminHttpBinding,
  ): () => void {
    const fullPath = joinPath(this.mountPath, binding.path)
    return this.ctx.http.route(binding.method, fullPath, (c) =>
      this.executeCapability(operation, binding, c),
    )
  }

  private async executeCapability(
    operation: AdminOperationDescription,
    binding: AdminHttpBinding,
    c: HttpContext,
  ): Promise<unknown> {
    const requestId = headerValue(c.headers["x-request-id"])
    return this.ctx.admin.execute(operation.name, {
      token: extractToken(c),
      input: buildInput(binding, c),
      ...(requestId === undefined ? {} : { requestId }),
      signal: c.signal,
      expectedRegistrationId: operation.registrationId,
    })
  }

  private disposeCapabilities(): void {
    for (const dispose of this.capabilityDisposers.values()) {
      dispose()
    }
    this.capabilityDisposers.clear()
  }
}

export default AdminBackendService

// ---- 模块级辅助 ----

/** 从 Authorization 头提取 Bearer Token；缺失或格式错误抛 unauthenticated。 */
function extractToken(c: HttpContext): string {
  const raw = headerValue(c.headers.authorization)
  if (raw === undefined || !raw.startsWith("Bearer ")) {
    throw new AdminError("unauthenticated", "缺少或无效的 Authorization 头")
  }
  const token = raw.slice("Bearer ".length).trim()
  if (token.length === 0) {
    throw new AdminError("unauthenticated", "Authorization 头缺少凭据")
  }
  return token
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

/** 显式选择 DTO 来源，不隐式合并 body/query/params，避免字段互相覆盖。 */
function buildInput(binding: AdminHttpBinding, c: HttpContext): unknown {
  if (binding.inputSource === "request") {
    return { params: c.params, query: queryToObject(c.query), body: c.body ?? null }
  }
  return binding.inputSource === "query" ? queryToObject(c.query) : (c.body ?? null)
}

function queryToObject(query: URLSearchParams): Record<string, string | string[]> {
  const result = Object.create(null) as Record<string, string | string[]>
  for (const key of new Set(query.keys())) {
    const values = query.getAll(key)
    result[key] = values.length === 1 ? values[0]! : values
  }
  return result
}

function capabilityKey(operation: AdminOperationDescription, binding: AdminHttpBinding): string {
  return `${operation.registrationId}:${binding.method}:${binding.path}`
}

function joinPath(mountPath: string, path: string): string {
  return mountPath === "/" ? path : `${mountPath}${path}`
}

function listAdminsInput(c: HttpContext) {
  const limit = parseQueryInt(c.query, "limit")
  const beforeCreatedAt = c.query.get("beforeCreatedAt")
  const beforeAdminId = c.query.get("beforeAdminId")
  return {
    ...(limit === undefined ? {} : { limit }),
    ...(beforeCreatedAt === null || beforeAdminId === null
      ? {}
      : { before: { createdAt: beforeCreatedAt, adminId: beforeAdminId } }),
  }
}

function parseQueryInt(query: URLSearchParams, name: string): number | undefined {
  const raw = query.get(name)
  if (raw === null) {
    return undefined
  }
  const value = Number(raw)
  return Number.isSafeInteger(value) ? value : undefined
}

function roleOf(body: unknown): AdminRole {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new AdminError("invalid-input", "请求体必须是对象")
  }
  const role = (body as { role?: unknown }).role
  if (role !== "superadmin" && role !== "admin" && role !== "viewer") {
    throw new AdminError("invalid-input", "role 必须是 superadmin、admin 或 viewer")
  }
  return role
}

function cleanupLimit(body: unknown): number {
  if (body === null || body === undefined) {
    return 100
  }
  if (typeof body !== "object" || Array.isArray(body)) {
    throw new AdminError("invalid-input", "请求体必须是对象")
  }
  const limit = (body as { limit?: unknown }).limit
  if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1) {
    throw new AdminError("invalid-input", "limit 必须是正整数")
  }
  return limit
}
