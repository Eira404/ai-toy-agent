export type ParallelErrorCode =
  | "INVALID_OPTIONS"
  | "UNKNOWN_POOL"
  | "QUEUE_FULL"
  | "QUEUE_TIMEOUT"
  | "ATTEMPT_TIMEOUT"
  | "TOTAL_TIMEOUT"
  | "CANCELLED"
  | "SERVICE_CLOSED"
  | "TASK_FAILED"
  | "POOL_REENTRY"

export interface ParallelErrorInfo {
  readonly taskId?: string
  readonly batchId?: string
  readonly pool?: string
  readonly attempts?: number
  readonly cause?: unknown
}

/** 保留原始 cause；不解析任务业务错误或返回值。 */
export class ParallelError extends Error {
  readonly taskId: string | undefined
  readonly batchId: string | undefined
  readonly pool: string | undefined
  readonly attempts: number

  constructor(
    readonly code: ParallelErrorCode,
    message: string,
    info: ParallelErrorInfo = {},
  ) {
    super(message, { cause: info.cause })
    this.name = "ParallelError"
    this.taskId = info.taskId
    this.batchId = info.batchId
    this.pool = info.pool
    this.attempts = info.attempts ?? 0
  }
}

/** 严格批次失败，cause 为首个失败；任务已执行的副作用不会回滚。 */
export class ParallelBatchError extends ParallelError {
  constructor(
    readonly index: number,
    info: ParallelErrorInfo & { batchId: string },
  ) {
    super(
      info.cause instanceof ParallelError ? info.cause.code : "TASK_FAILED",
      `批次 '${info.batchId}' 执行失败（输入位置 ${index}）`,
      info,
    )
    this.name = "ParallelBatchError"
  }
}
