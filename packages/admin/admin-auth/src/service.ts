import { randomUUID } from "node:crypto"
import { Service, type Context } from "cordis"
import "toy-storage"
import {
  RelationalError,
  type RelationalAdapter,
  type RelationalExecutor,
  type RelationalRecord,
} from "toy-storage-relational"
import { resolveConfig } from "./config.js"
import { AdminAuthError } from "./error.js"
import { and, eq, loginName, objectInput, password, positive, text, timestamp } from "./helpers.js"
import { PasswordHasher } from "./password.js"
import { assertCanManage, assertPermission, isAdminRole } from "./permissions.js"
import { assertAdminAuthSchema, profile, roleOf, stringField, versionOf } from "./relational.js"
import {
  ADMIN_ACCOUNTS_TABLE as ACCOUNTS,
  ADMIN_AUTH_STATE_TABLE as STATE,
  ADMIN_SECURITY_EVENTS_TABLE as EVENTS,
  ADMIN_SESSIONS_TABLE as SESSIONS,
} from "./schema.js"
import { digest, newToken, tokenDigest } from "./token.js"
import type {
  AdminAuthConfig,
  AdminIdentity,
  AdminPage,
  AdminProfile,
  AdminPermission,
  AdminRole,
  AdminSecurityAction,
  AdminSecurityOutcome,
  ChangePasswordInput,
  CreateAdminInput,
  ListAdminsInput,
  LoginInput,
  LoginResult,
} from "./types.js"

declare module "cordis" {
  interface Context {
    adminAuth: AdminAuth
  }
}

interface Authenticated {
  account: RelationalRecord
  session: RelationalRecord
}

const STATE_ID = "singleton"

/** 管理员账号与服务端登录会话；不依赖 HTTP，不参与 Agent 对话 Session。 */
export class AdminAuth extends Service {
  static inject = ["storage", "storageRelational"]

  private readonly config: ReturnType<typeof resolveConfig>
  private readonly passwords: PasswordHasher
  private source: RelationalAdapter | undefined

  constructor(ctx: Context, config: AdminAuthConfig = {}) {
    super(ctx, "adminAuth")
    this.config = resolveConfig(config)
    this.passwords = new PasswordHasher(this.config.maxConcurrentPasswordOps)
  }

  /** 校验宿主 schema 并创建单例状态；重复挂载绝不重置初始化标记。 */
  async [Service.init](): Promise<void> {
    const source = this.ctx.storage.tryGet<RelationalAdapter>("relational", this.config.sourceName)
    if (source === undefined) {
      throw new AdminAuthError("source-not-ready", "管理员认证的关系型存储尚未就绪")
    }
    assertAdminAuthSchema(source)
    try {
      await source.execute({
        type: "insert",
        table: STATE,
        value: { state_id: STATE_ID, bootstrapped: false, lock_token: randomUUID() },
      })
    } catch (error) {
      if (!(error instanceof RelationalError) || error.code !== "duplicate-key") {
        throw error
      }
    }
    this.source = source
    this.ctx.effect(
      () => () => {
        this.source = undefined
      },
      "admin-auth.source",
    )
  }

  /** 仅供可信宿主初始化使用；禁止暴露为公开注册接口，数据库内只能成功一次。 */
  async bootstrap(input: CreateAdminInput): Promise<AdminProfile> {
    const draft = this.accountInput(input)
    if (input.role !== undefined && input.role !== "superadmin") {
      throw new AdminAuthError("invalid-input", "首个管理员必须是 superadmin")
    }
    const hash = await this.passwords.run(() => this.passwords.hash(draft.password))
    return this.mutate(async (tx, now) => {
      const state = await tx.execute({ type: "get", table: STATE, key: STATE_ID })
      const count = await tx.execute({ type: "count", table: ACCOUNTS })
      if (state.row?.bootstrapped !== false || count.count !== 0) {
        throw new AdminAuthError("already-initialized", "管理员已初始化")
      }
      const row = await this.insertAccount(tx, { ...draft, role: "superadmin" }, hash, now)
      await tx.execute({
        type: "update",
        table: STATE,
        where: eq("state_id", STATE_ID),
        patch: { bootstrapped: true },
      })
      await this.event(
        tx,
        now,
        "bootstrap",
        "success",
        stringField(row, "admin_id"),
        stringField(row, "admin_id"),
      )
      return profile(row)
    })
  }

  /** 失败/进行中尝试按登录名在数据库内限流；昂贵计算在事务外执行。 */
  async login(input: LoginInput): Promise<LoginResult> {
    objectInput(input)
    const name = loginName(input.loginName)
    const secret = password(input.password)
    const subject = digest(name)
    const attempt = await this.mutate(async (tx, now) => {
      const since = new Date(Date.parse(now) - this.config.loginWindowMs).toISOString()
      const failures = await tx.execute({
        type: "count",
        table: EVENTS,
        where: and(
          eq("subject_digest", subject),
          eq("action", "login"),
          { type: "gte", field: "occurred_at", value: since },
          { type: "in", field: "outcome", values: ["pending", "invalid-credentials"] },
        ),
      })
      if (failures.count >= this.config.maxLoginAttempts) {
        await this.event(tx, now, "login", "rate-limited", null, null, subject)
        return { allowed: false } as const
      }
      const eventId = await this.event(tx, now, "login", "pending", null, null, subject)
      const result = await tx.execute({
        type: "find",
        table: ACCOUNTS,
        where: eq("login_name", name),
        limit: 1,
      })
      return { allowed: true, eventId, account: result.rows[0] } as const
    })
    if (!attempt.allowed) {
      throw new AdminAuthError("rate-limited", "登录尝试过于频繁，请稍后重试")
    }
    let matches: boolean
    try {
      matches = await this.passwords.run(() =>
        this.passwords.verify(
          secret,
          attempt.account === undefined ? undefined : stringField(attempt.account, "password_hash"),
        ),
      )
    } catch (error) {
      if (error instanceof AdminAuthError && error.code === "auth-busy") {
        await this.mutate((tx) => this.finishAttempt(tx, attempt.eventId, "auth-busy"))
      }
      throw error
    }
    const result = await this.mutate(async (tx, now) => {
      const original = attempt.account
      const current =
        original === undefined
          ? undefined
          : (
              await tx.execute({
                type: "get",
                table: ACCOUNTS,
                key: stringField(original, "admin_id"),
              })
            ).row
      if (
        !matches ||
        current?.enabled !== true ||
        original === undefined ||
        versionOf(current) !== versionOf(original) ||
        current.password_hash !== original.password_hash
      ) {
        await this.finishAttempt(tx, attempt.eventId, "invalid-credentials")
        return undefined
      }
      const token = newToken()
      const sessionId = randomUUID()
      const expiresAt = new Date(Date.parse(now) + this.config.sessionTtlMs).toISOString()
      const adminId = stringField(current, "admin_id")
      await tx.execute({
        type: "insert",
        table: SESSIONS,
        value: {
          session_id: sessionId,
          admin_id: adminId,
          token_digest: digest(token),
          security_version: versionOf(current),
          created_at: now,
          expires_at: expiresAt,
          revoked_at: null,
        },
      })
      await this.finishAttempt(tx, attempt.eventId, "success", adminId)
      return { token, sessionId, expiresAt, admin: profile(current) }
    })
    if (result === undefined) {
      throw new AdminAuthError("invalid-credentials", "账号或密码错误")
    }
    return result
  }

  /** 每次校验会话与当前账号状态；返回身份快照不作为下次调用的授权凭据。 */
  async authenticate(token: string): Promise<AdminIdentity> {
    const hash = tokenDigest(token)
    return this.read(async (tx, now) => {
      const { account, session } = await this.requireIdentity(tx, hash, now)
      return {
        admin: profile(account),
        sessionId: stringField(session, "session_id"),
        expiresAt: stringField(session, "expires_at"),
      }
    })
  }

  async getMe(token: string): Promise<AdminProfile> {
    return (await this.authenticate(token)).admin
  }

  /** 验证当前身份及操作权限；admins.manage 不替代具体方法对目标账号的检查。 */
  async authorize(token: string, permission: AdminPermission): Promise<AdminIdentity> {
    const identity = await this.authenticate(token)
    assertPermission(identity.admin.role, permission)
    return identity
  }

  /** 幂等退出；格式正确但不存在、已撤销的凭据也可重复退出。 */
  async logout(token: string): Promise<void> {
    const hash = tokenDigest(token)
    await this.mutate(async (tx, now) => {
      const result = await tx.execute({
        type: "find",
        table: SESSIONS,
        where: eq("token_digest", hash),
        limit: 1,
      })
      const session = result.rows[0]
      if (session === undefined || session.revoked_at !== null) {
        return
      }
      const adminId = stringField(session, "admin_id")
      await tx.execute({
        type: "update",
        table: SESSIONS,
        where: eq("session_id", stringField(session, "session_id")),
        patch: { revoked_at: now },
      })
      await this.event(tx, now, "logout", "success", adminId, adminId)
    })
  }

  /** 默认创建 viewer；普通管理员仅能创建 viewer，超级管理员可创建任意角色。 */
  async createAdmin(token: string, input: CreateAdminInput): Promise<AdminProfile> {
    const draft = this.accountInput(input)
    const identity = await this.authorize(token, "admins.create")
    assertCanManage(identity.admin.role, draft.role)
    const hash = await this.passwords.run(() => this.passwords.hash(draft.password))
    return this.withActor(token, async (tx, actor, now) => {
      assertCanManage(roleOf(actor.account), draft.role)
      const existing = await tx.execute({
        type: "count",
        table: ACCOUNTS,
        where: eq("login_name", draft.loginName),
      })
      if (existing.count > 0) {
        throw new AdminAuthError("admin-exists", "管理员登录名已存在")
      }
      const row = await this.insertAccount(tx, draft, hash, now)
      await this.event(
        tx,
        now,
        "create-admin",
        "success",
        stringField(actor.account, "admin_id"),
        stringField(row, "admin_id"),
      )
      return profile(row)
    })
  }

  async getAdmin(token: string, adminId: string): Promise<AdminProfile | undefined> {
    const id = text(adminId, "adminId")
    const hash = tokenDigest(token)
    return this.read(async (tx, now) => {
      await this.requireIdentity(tx, hash, now)
      const result = await tx.execute({ type: "get", table: ACCOUNTS, key: id })
      return result.row === undefined ? undefined : profile(result.row)
    })
  }

  /** 创建时间、ID 倒序的稳定游标分页，默认 20，最多 100。 */
  async listAdmins(token: string, input: ListAdminsInput = {}): Promise<AdminPage> {
    objectInput(input)
    const limit = positive(input.limit ?? 20, "limit", 100)
    const before = input.before
    if (before !== undefined) {
      objectInput(before)
    }
    const cursor =
      before === undefined
        ? undefined
        : {
            createdAt: timestamp(before.createdAt),
            adminId: text(before.adminId, "before.adminId"),
          }
    const hash = tokenDigest(token)
    return this.read(async (tx, now) => {
      await this.requireIdentity(tx, hash, now)
      const result = await tx.execute({
        type: "find",
        table: ACCOUNTS,
        limit: limit + 1,
        orderBy: [
          { field: "created_at", direction: "desc" },
          { field: "admin_id", direction: "desc" },
        ],
        ...(cursor === undefined
          ? {}
          : {
              where: {
                type: "or" as const,
                conditions: [
                  { type: "lt" as const, field: "created_at", value: cursor.createdAt },
                  and(eq("created_at", cursor.createdAt), {
                    type: "lt",
                    field: "admin_id",
                    value: cursor.adminId,
                  }),
                ],
              },
            }),
      })
      const items = result.rows.slice(0, limit).map(profile)
      const last = items.at(-1)
      return {
        items,
        nextCursor:
          result.rows.length > limit && last !== undefined
            ? { createdAt: last.createdAt, adminId: last.adminId }
            : undefined,
      }
    })
  }

  /** 按角色限制管理目标，并保护最后一个有效超级管理员。 */
  async disableAdmin(token: string, adminId: string): Promise<void> {
    await this.setEnabled(token, adminId, false)
  }

  /** 启用账号不会恢复此前的会话，需重新登录。 */
  async enableAdmin(token: string, adminId: string): Promise<void> {
    await this.setEnabled(token, adminId, true)
  }

  /** 仅超级管理员可以调整角色；实际变更会撤销目标全部会话，并记录安全事件。 */
  async setAdminRole(token: string, adminId: string, role: AdminRole): Promise<AdminProfile> {
    const id = text(adminId, "adminId")
    if (!isAdminRole(role)) {
      throw new AdminAuthError("invalid-input", "role 必须是 superadmin、admin 或 viewer")
    }
    return this.withActor(token, async (tx, actor, now) => {
      assertPermission(roleOf(actor.account), "admins.roles")
      const target = await this.requireAccount(tx, id)
      if (roleOf(target) === role) {
        return profile(target)
      }
      await this.protectLastSuperadmin(tx, target)
      await tx.execute({
        type: "update",
        table: ACCOUNTS,
        where: eq("admin_id", id),
        patch: { role, updated_at: now },
      })
      await this.revokeAll(tx, target, now)
      await this.event(tx, now, "set-role", "success", stringField(actor.account, "admin_id"), id)
      return profile(await this.requireAccount(tx, id))
    })
  }

  /** 校验旧密码后修改；同一事务内撤销所有会话，包括本次调用使用的会话。 */
  async changePassword(token: string, input: ChangePasswordInput): Promise<void> {
    objectInput(input)
    const current = password(input.currentPassword)
    const next = password(input.newPassword, true)
    const hash = tokenDigest(token)
    const original = await this.read(
      async (tx, now) => (await this.requireIdentity(tx, hash, now)).account,
    )
    const newHash = await this.passwords.run(async () => {
      if (!(await this.passwords.verify(current, stringField(original, "password_hash")))) {
        throw new AdminAuthError("invalid-credentials", "当前密码错误")
      }
      return this.passwords.hash(next)
    })
    await this.withActor(token, async (tx, actor, now) => {
      if (
        versionOf(actor.account) !== versionOf(original) ||
        actor.account.password_hash !== original.password_hash
      ) {
        throw new AdminAuthError("unauthenticated", "账号安全状态已变更，请重新登录")
      }
      const id = stringField(actor.account, "admin_id")
      await tx.execute({
        type: "update",
        table: ACCOUNTS,
        where: eq("admin_id", id),
        patch: { password_hash: newHash, password_changed_at: now, updated_at: now },
      })
      await this.revokeAll(tx, actor.account, now)
      await this.event(tx, now, "change-password", "success", id, id)
    })
  }

  async revokeMySessions(token: string): Promise<void> {
    await this.withActor(token, async (tx, actor, now) => {
      const id = stringField(actor.account, "admin_id")
      await this.revokeAll(tx, actor.account, now)
      await this.event(tx, now, "revoke-sessions", "success", id, id)
    })
  }

  async revokeAdminSessions(token: string, adminId: string): Promise<void> {
    const id = text(adminId, "adminId")
    await this.withActor(token, async (tx, actor, now) => {
      const target = await this.requireAccount(tx, id)
      assertCanManage(roleOf(actor.account), roleOf(target))
      await this.revokeAll(tx, target, now)
      await this.event(
        tx,
        now,
        "revoke-sessions",
        "success",
        stringField(actor.account, "admin_id"),
        id,
      )
    })
  }

  /** 清理最多 limit 条过期或已撤销会话；无自动定时器，由宿主选择调用时机。 */
  async cleanupExpiredSessions(token: string, limit = 100): Promise<number> {
    positive(limit, "limit", 1000)
    return this.withActor(token, async (tx, actor, now) => {
      assertPermission(roleOf(actor.account), "sessions.cleanup")
      const result = await tx.execute({
        type: "find",
        table: SESSIONS,
        where: {
          type: "or",
          conditions: [
            { type: "lte", field: "expires_at", value: now },
            { type: "not", condition: { type: "isNull", field: "revoked_at" } },
          ],
        },
        orderBy: [{ field: "session_id", direction: "asc" }],
        limit,
      })
      if (result.rows.length === 0) {
        return 0
      }
      const deleted = await tx.execute({
        type: "delete",
        table: SESSIONS,
        where: {
          type: "in",
          field: "session_id",
          values: result.rows.map((row) => stringField(row, "session_id")),
        },
      })
      return deleted.affectedRows
    })
  }

  private async setEnabled(token: string, adminId: string, enabled: boolean): Promise<void> {
    const id = text(adminId, "adminId")
    await this.withActor(token, async (tx, actor, now) => {
      const target = await this.requireAccount(tx, id)
      assertCanManage(roleOf(actor.account), roleOf(target))
      if (target.enabled !== enabled) {
        if (!enabled) {
          await this.protectLastSuperadmin(tx, target)
        }
        await tx.execute({
          type: "update",
          table: ACCOUNTS,
          where: eq("admin_id", id),
          patch: { enabled, updated_at: now },
        })
        await this.revokeAll(tx, target, now)
      }
      await this.event(
        tx,
        now,
        enabled ? "enable-admin" : "disable-admin",
        "success",
        stringField(actor.account, "admin_id"),
        id,
      )
    })
  }

  private accountInput(input: CreateAdminInput) {
    objectInput(input)
    const name = loginName(input.loginName)
    const role = input.role === undefined ? "viewer" : input.role
    if (!isAdminRole(role)) {
      throw new AdminAuthError("invalid-input", "role 必须是 superadmin、admin 或 viewer")
    }
    return {
      loginName: name,
      role,
      displayName: input.displayName === undefined ? name : text(input.displayName, "displayName"),
      password: password(input.password, true),
    }
  }

  private async insertAccount(
    tx: RelationalExecutor,
    draft: { loginName: string; displayName: string; role: AdminRole },
    hash: string,
    now: string,
  ): Promise<RelationalRecord> {
    const row = {
      admin_id: randomUUID(),
      login_name: draft.loginName,
      display_name: draft.displayName,
      role: draft.role,
      password_hash: hash,
      enabled: true,
      security_version: 1,
      created_at: now,
      updated_at: now,
      password_changed_at: now,
    }
    await tx.execute({ type: "insert", table: ACCOUNTS, value: row })
    return row
  }

  private async requireAccount(tx: RelationalExecutor, id: string): Promise<RelationalRecord> {
    const result = await tx.execute({ type: "get", table: ACCOUNTS, key: id })
    if (result.row === undefined) {
      throw new AdminAuthError("admin-not-found", "管理员不存在")
    }
    return result.row
  }

  private async protectLastSuperadmin(
    tx: RelationalExecutor,
    target: RelationalRecord,
  ): Promise<void> {
    if (target.enabled !== true || roleOf(target) !== "superadmin") {
      return
    }
    const count = await tx.execute({
      type: "count",
      table: ACCOUNTS,
      where: and(eq("enabled", true), eq("role", "superadmin")),
    })
    if (count.count <= 1) {
      throw new AdminAuthError("last-superadmin", "不能禁用或降级最后一个有效超级管理员")
    }
  }

  private async requireIdentity(
    tx: RelationalExecutor,
    hash: string,
    now: string,
  ): Promise<Authenticated> {
    const result = await tx.execute({
      type: "find",
      table: SESSIONS,
      where: eq("token_digest", hash),
      limit: 1,
    })
    const session = result.rows[0]
    if (
      session !== undefined &&
      session.revoked_at === null &&
      Date.parse(stringField(session, "expires_at")) > Date.parse(now)
    ) {
      const account = (
        await tx.execute({ type: "get", table: ACCOUNTS, key: stringField(session, "admin_id") })
      ).row
      if (account?.enabled === true && versionOf(account) === versionOf(session)) {
        roleOf(account)
        return { account, session }
      }
    }
    throw new AdminAuthError("unauthenticated", "登录凭据无效或已失效")
  }

  private async revokeAll(
    tx: RelationalExecutor,
    account: RelationalRecord,
    now: string,
  ): Promise<void> {
    const id = stringField(account, "admin_id")
    // 版本同时阻止已开始密码校验、尚未发放 Token 的旧登录请求。
    await tx.execute({
      type: "update",
      table: ACCOUNTS,
      where: eq("admin_id", id),
      patch: { security_version: versionOf(account) + 1, updated_at: now },
    })
    await tx.execute({
      type: "update",
      table: SESSIONS,
      where: and(eq("admin_id", id), { type: "isNull", field: "revoked_at" }),
      patch: { revoked_at: now },
    })
  }

  private async event(
    tx: RelationalExecutor,
    now: string,
    action: AdminSecurityAction,
    outcome: AdminSecurityOutcome,
    actor: string | null = null,
    target: string | null = null,
    subject: string | null = null,
  ): Promise<string> {
    const id = randomUUID()
    await tx.execute({
      type: "insert",
      table: EVENTS,
      value: {
        event_id: id,
        action,
        outcome,
        actor_id: actor,
        target_id: target,
        subject_digest: subject,
        occurred_at: now,
      },
    })
    return id
  }

  private async finishAttempt(
    tx: RelationalExecutor,
    eventId: string,
    outcome: AdminSecurityOutcome,
    adminId: string | null = null,
  ): Promise<void> {
    const result = await tx.execute({
      type: "update",
      table: EVENTS,
      where: eq("event_id", eventId),
      patch: { outcome, actor_id: outcome === "success" ? adminId : null, target_id: adminId },
    })
    if (result.affectedRows !== 1) {
      throw new AdminAuthError("schema-mismatch", "登录尝试记录缺失，拒绝提交登录结果")
    }
  }

  private withActor<T>(
    token: string,
    work: (tx: RelationalExecutor, actor: Authenticated, now: string) => Promise<T>,
  ): Promise<T> {
    const hash = tokenDigest(token)
    return this.mutate(async (tx, now) => work(tx, await this.requireIdentity(tx, hash, now), now))
  }

  /** 先更新单例行获得数据库写锁，再读身份/账号；所有安全写入遵守同一顺序。 */
  private mutate<T>(work: (tx: RelationalExecutor, now: string) => Promise<T>): Promise<T> {
    return this.requireSource().transaction(
      async (tx) => {
        const locked = await tx.execute({
          type: "update",
          table: STATE,
          where: eq("state_id", STATE_ID),
          patch: { lock_token: randomUUID() },
        })
        if (locked.affectedRows !== 1) {
          throw new AdminAuthError("schema-mismatch", "管理员认证状态记录缺失")
        }
        return work(tx, timestamp(this.config.now()))
      },
      { isolation: "read-committed" },
    )
  }

  private read<T>(work: (tx: RelationalExecutor, now: string) => Promise<T>): Promise<T> {
    return this.requireSource().transaction((tx) => work(tx, timestamp(this.config.now())), {
      isolation: "repeatable-read",
      readOnly: true,
    })
  }

  private requireSource(): RelationalAdapter {
    if (this.source === undefined) {
      throw new AdminAuthError("source-not-ready", "管理员认证存储尚未初始化或插件已卸载")
    }
    return this.source
  }
}

export default AdminAuth
