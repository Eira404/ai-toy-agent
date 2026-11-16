/** 本包的稳定错误码；底层数据库错误原样传播，不自动重试未知提交。 */
export type AdminAuthErrorCode =
  | "invalid-input"
  | "source-not-ready"
  | "schema-mismatch"
  | "transactions-required"
  | "already-initialized"
  | "admin-exists"
  | "admin-not-found"
  | "invalid-credentials"
  | "unauthenticated"
  | "forbidden"
  | "last-superadmin"
  | "rate-limited"
  | "auth-busy"

export class AdminAuthError extends Error {
  constructor(
    readonly code: AdminAuthErrorCode,
    message: string,
  ) {
    super(message)
    this.name = "AdminAuthError"
  }
}
