/** `toy-memory-daily` 的错误码。 */
export type DailyMemoryErrorCode =
  /** 调用方输入非法（空 ID、非法枚举、重复变更等）。 */
  | "invalid-input"
  /** 命名存储实例尚未就绪。 */
  | "source-not-ready"
  /** 数据源 schema 与本包定义不一致。 */
  | "schema-mismatch"
  /** 价值引擎已注册。 */
  | "engine-already-registered"
  /** 批次不存在或不属于该空间。 */
  | "batch-not-found"
  /** 批次状态与操作不匹配。 */
  | "invalid-state"
  /** 同空间已存在未完成 Daily。 */
  | "conflict"

/** Daily 包统一抛出的业务错误，携带稳定错误码供上层区分处理。 */
export class DailyMemoryError extends Error {
  readonly code: DailyMemoryErrorCode

  constructor(code: DailyMemoryErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = "DailyMemoryError"
    this.code = code
  }
}
