/** 插件配置；可以先挂载服务，再通过 registerPool 提供任务池。 */
export interface ParallelExecutorConfig {
  /** 批次默认并发，默认 4；每批默认值还会受池上限裁剪。 */
  defaultMapConcurrency?: number
  pools?: Record<string, TaskPoolConfig>
}

export interface RetryContext {
  readonly pool: string
  readonly taskId: string
  /** 刚刚失败的尝试，从 1 开始。 */
  readonly attempt: number
}

/** 重试整个任务函数，而非自动重试任务内部某一个请求。 */
export interface RetryPolicy {
  maxAttempts: number
  shouldRetry: (error: unknown, context: RetryContext) => boolean
  /** 默认 500ms。 */
  baseDelayMs?: number
  /** 默认 10000ms。 */
  maxDelayMs?: number
  /** 默认 true，使用 full jitter。 */
  jitter?: boolean
  retryAfterMs?: (error: unknown) => number | undefined
}

export interface TaskPolicy {
  /** 默认 30000ms；null 表示不限，每次入队重新计时。 */
  queueTimeoutMs?: number | null
  /** 默认 null；超时发出取消，等待函数退出后才释放名额。 */
  attemptTimeoutMs?: number | null
  /** 默认 null；包含排队、执行、退避与重试。 */
  totalTimeoutMs?: number | null
  /** 默认 false；覆盖时完整替换，不做策略字段合并。 */
  retry?: RetryPolicy | false
}

export interface TaskPoolConfig extends TaskPolicy {
  maxConcurrency: number
  /** 默认 1000，允许 0；仅统计等待池名额的任务。 */
  maxQueueSize?: number
}

export interface TaskContext {
  readonly pool: string
  readonly taskId: string
  readonly batchId?: string
  readonly name?: string
  readonly attempt: number
  readonly signal: AbortSignal
}

export interface MapTaskContext extends TaskContext {
  readonly batchId: string
  readonly index: number
}

export interface RunOptions extends TaskPolicy {
  pool: string
  /** 仅关联执行信息，不提供去重或幂等保证。 */
  taskId?: string
  batchId?: string
  name?: string
  signal?: AbortSignal
}

export interface MapOptions {
  pool: string
  /** 限制本批排队、执行、退避中的项目总数；默认 min(4, 池上限)。 */
  concurrency?: number
  batchId?: string
  name?: string
  signal?: AbortSignal
  batchTimeoutMs?: number | null
  /** 每个项目提交时覆盖池默认策略。 */
  task?: TaskPolicy
}

interface TaskResultBase {
  readonly taskId: string
  readonly index: number
  readonly attempts: number
}

export type TaskResult<R> = TaskResultBase &
  (
    | { readonly status: "fulfilled"; readonly value: R }
    | { readonly status: "rejected"; readonly error: unknown }
    | { readonly status: "cancelled"; readonly reason: unknown }
  )

export interface PoolStats {
  readonly maxConcurrency: number
  readonly maxQueueSize: number
  readonly running: number
  readonly queued: number
  readonly retryWaiting: number
  /** 通过调用校验后提交的逻辑任务数，包含入队失败。 */
  readonly submitted: number
  readonly succeeded: number
  readonly failed: number
  readonly cancelled: number
  readonly attemptsStarted: number
}

export interface ParallelStats {
  readonly activeBatches: number
  readonly pools: Record<string, PoolStats>
}

export interface WaitForIdleOptions {
  /** 仅取消本次等待，不取消执行中的任务。 */
  signal?: AbortSignal
}
