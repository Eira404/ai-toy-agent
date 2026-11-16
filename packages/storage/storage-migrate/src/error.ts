/** `toy-storage-migrate` 的错误码。 */
export type MigrateErrorCode =
  /** 无法建立数据库连接。 */
  | "connection-failed"
  /** 输入 Schema 或 SQL 标识符非法。 */
  | "invalid-schema"
  /** 非空新列既没有 default 也没有 backfill，存量行无法回填。 */
  | "not-null-without-default"

/** migrate 包统一抛出的业务错误，携带稳定错误码供上层区分处理。 */
export class MigrateError extends Error {
  readonly code: MigrateErrorCode

  constructor(code: MigrateErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = "MigrateError"
    this.code = code
  }
}
