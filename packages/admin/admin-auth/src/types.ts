/** 固定三类角色；不能由登录请求或身份快照指定权限。 */
export type AdminRole = "superadmin" | "admin" | "viewer"

/** 本包的操作权限；目标账号的角色限制仍由对应服务方法检查。 */
export type AdminPermission =
  "admins.read" | "admins.create" | "admins.manage" | "admins.roles" | "sessions.cleanup"

export interface AdminAuthConfig {
  /** 已由宿主挂载的关系型存储实例名，默认 main，必须支持事务。 */
  readonly sourceName?: string
  /** 固定登录有效期，默认 8 小时；不滑动续期。 */
  readonly sessionTtlMs?: number
  /** 同一规范化登录名的失败/进行中尝试统计窗口，默认 15 分钟。 */
  readonly loginWindowMs?: number
  /** 窗口内最多失败/进行中尝试数，默认 5；成功登录不计数。 */
  readonly maxLoginAttempts?: number
  /** 单实例同时执行密码计算的上限，默认 2；超出立即拒绝。 */
  readonly maxConcurrentPasswordOps?: number
  /** 测试可注入时钟，返回可解析的 ISO 时间字符串。 */
  readonly now?: () => string
}

/** 安全的公开账号信息，不包含密码、Token 或内部安全版本。 */
export interface AdminProfile {
  readonly adminId: string
  readonly loginName: string
  readonly displayName: string
  readonly role: AdminRole
  readonly enabled: boolean
  readonly createdAt: string
  readonly updatedAt: string
  readonly passwordChangedAt: string
}

export interface CreateAdminInput {
  /** 去首尾空白并转小写后，须为 3–64 位 ASCII 字母、数字、点、下划线或短横线。 */
  readonly loginName: string
  /** 12–128 个 Unicode 字符，最多 512 UTF-8 字节；不裁剪、不规范化。 */
  readonly password: string
  readonly displayName?: string
  /** createAdmin 默认 viewer；bootstrap 只能省略或指定 superadmin。 */
  readonly role?: AdminRole
}

export interface LoginInput {
  readonly loginName: string
  readonly password: string
}

export interface LoginResult {
  /** 原始凭据仅由 login 返回；宿主不能写入日志。 */
  readonly token: string
  readonly sessionId: string
  readonly expiresAt: string
  readonly admin: AdminProfile
}

/** 本次校验时的身份快照；以后每次受保护调用仍须重新校验 Token。 */
export interface AdminIdentity {
  readonly admin: AdminProfile
  readonly sessionId: string
  readonly expiresAt: string
}

export interface ChangePasswordInput {
  readonly currentPassword: string
  readonly newPassword: string
}

export interface AdminCursor {
  readonly createdAt: string
  readonly adminId: string
}

export interface ListAdminsInput {
  readonly limit?: number
  readonly before?: AdminCursor
}

export interface AdminPage {
  readonly items: readonly AdminProfile[]
  readonly nextCursor: AdminCursor | undefined
}

export type AdminSecurityAction =
  | "bootstrap"
  | "login"
  | "logout"
  | "create-admin"
  | "disable-admin"
  | "enable-admin"
  | "change-password"
  | "revoke-sessions"
  | "set-role"

export type AdminSecurityOutcome =
  "pending" | "success" | "invalid-credentials" | "rate-limited" | "auth-busy"
