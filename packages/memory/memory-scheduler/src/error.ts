/** `toy-memory-scheduler` 的错误码。 */
export type SchedulerErrorCode =
  /** 调用方输入非法（空 ID、非法钟点、非法阈值等）。 */
  | "invalid-input"
  /** 命名关系型存储实例尚未就绪。 */
  | "source-not-ready"
  /** 数据源 schema 与本包定义不一致。 */
  | "schema-mismatch"
  /** 目标空间没有调度配置（disable 时）。 */
  | "schedule-not-found"

/** Scheduler 包统一抛出的业务错误，携带稳定错误码供上层区分处理。 */
export class SchedulerError extends Error {
  readonly code: SchedulerErrorCode

  constructor(code: SchedulerErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = "SchedulerError"
    this.code = code
  }
}
