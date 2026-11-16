import type { StorageDescriptor } from "toy-storage"

/** 一项由已注册存储实例执行的写入任务；operation 的含义由目标实例定义。 */
export interface QueuedWriteJob<Operation = unknown> {
  /** 在 queueName 内唯一，建议使用业务记录的稳定 ID。 */
  readonly jobId: string
  /** 逻辑队列名；同一队列严格按入队顺序写入。 */
  readonly queueName: string
  /** 指向 ctx.storage 中已经就绪的命名实例。 */
  readonly target: StorageDescriptor
  /** 交给目标实例现有 execute 方法的操作。 */
  readonly operation: Operation
}

/** 入队后返回的凭据；即使任务已从队列移除，仍可查询其完成状态。 */
export interface WriteReceipt {
  readonly queueName: string
  readonly jobId: string
}

/** 队列任务从接收到数据库确认后的状态。 */
export type WriteJobStatus = "queued" | "writing" | "retrying" | "blocked" | "committed"

/** 等待一项或一批任务确认写入的选项。 */
export interface WriteWaitOptions {
  /** 等待超时只取消本次等待，不取消队列中的写入。 */
  readonly timeoutMs?: number
  /** 取消信号只取消本次等待。 */
  readonly signal?: AbortSignal
}

/** 等待调用时已经入队的一批任务完成。 */
export interface WriteFlushOptions extends WriteWaitOptions {
  /** 省略时等待所有逻辑队列当前已有的任务。 */
  readonly queueName?: string
}

/** 队列与目标存储的写入并发和重试配置。 */
export interface StorageWriteQueueConfig {
  /** 同一 kind/name 同时执行的最大写入数；默认 1，为直接读写留出连接。 */
  readonly maxConcurrentPerTarget?: number
  /** 第一次安全重试的等待时间；默认 250 毫秒。 */
  readonly retryBaseMs?: number
  /** 重试间隔上限；默认 30000 毫秒。 */
  readonly retryMaxMs?: number
}

/** 当前仍未确认写入的任务数量和最早等待时间。 */
export interface WriteQueueStats {
  readonly queued: number
  readonly writing: number
  readonly retrying: number
  readonly blocked: number
  readonly pending: number
  readonly oldestPendingMs: number | undefined
}
