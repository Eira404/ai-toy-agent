import type { QueuedWriteJob, WriteJobStatus, WriteReceipt } from "./types.js"

/** 等待中的调用方；任务完成或阻塞时由队列统一通知。 */
export interface JobWaiter {
  resolve(): void
  reject(error: unknown): void
}

/** 凭据独立保存少量状态，不持有成功后应被释放的 operation。 */
export interface ReceiptState {
  readonly queueName: string
  readonly jobId: string
  readonly waiters: Set<JobWaiter>
  status: WriteJobStatus
  lastError?: unknown
}

/** 队列尚未确认写入的一项任务。 */
export interface QueueEntry {
  readonly job: QueuedWriteJob
  readonly receipt: WriteReceipt
  readonly state: ReceiptState
  readonly acceptedAt: number
  failures: number
  retryTimer: ReturnType<typeof setTimeout> | undefined
}

/** 同一逻辑队列的有序任务列表和当前执行占用。 */
export interface QueueLane {
  readonly name: string
  readonly entries: QueueEntry[]
  head: number
  running: boolean
}
