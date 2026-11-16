import { Cancellation } from "./control.js"
import { ParallelError } from "./error.js"
import type { ResolvedPool } from "./config.js"
import type { PoolStats } from "./types.js"

interface Waiter {
  grant(): void
}

/** 同名覆盖只换配置，运行计数、FIFO 队列与累计统计保持在同一对象上。 */
export class TaskPool {
  readonly queue: Waiter[] = []
  running = 0
  retryWaiting = 0
  submitted = 0
  succeeded = 0
  failed = 0
  cancelled = 0
  attemptsStarted = 0

  constructor(public config: ResolvedPool) {}

  configure(config: ResolvedPool): void {
    this.config = config
    this.pump()
  }

  async acquire(signal: AbortSignal, queueTimeoutMs: number | null): Promise<() => void> {
    signal.throwIfAborted()
    if (this.queue.length === 0 && this.running < this.config.maxConcurrency) {
      return this.reserve()
    }
    if (this.queue.length >= this.config.maxQueueSize) {
      throw new ParallelError("QUEUE_FULL", "任务池等待队列已满")
    }
    const queued = new Cancellation([signal])
    queued.deadline(queueTimeoutMs, "QUEUE_TIMEOUT")
    try {
      return await new Promise<() => void>((resolve, reject) => {
        const cleanup = () => {
          queued.signal.removeEventListener("abort", abort)
          queued.dispose()
        }
        const abort = () => {
          const index = this.queue.indexOf(waiter)
          if (index >= 0) {
            this.queue.splice(index, 1)
          }
          cleanup()
          reject(queued.signal.reason)
        }
        const waiter: Waiter = {
          grant: () => {
            cleanup()
            resolve(this.reserve())
          },
        }
        this.queue.push(waiter)
        queued.signal.addEventListener("abort", abort, { once: true })
        if (queued.signal.aborted) {
          abort()
        }
      })
    } finally {
      queued.dispose()
    }
  }

  snapshot(): PoolStats {
    return {
      maxConcurrency: this.config.maxConcurrency,
      maxQueueSize: this.config.maxQueueSize,
      running: this.running,
      queued: this.queue.length,
      retryWaiting: this.retryWaiting,
      submitted: this.submitted,
      succeeded: this.succeeded,
      failed: this.failed,
      cancelled: this.cancelled,
      attemptsStarted: this.attemptsStarted,
    }
  }

  private reserve(): () => void {
    this.running++
    let released = false
    return () => {
      if (!released) {
        released = true
        this.running--
        this.pump()
      }
    }
  }

  private pump(): void {
    while (this.running < this.config.maxConcurrency && this.queue.length > 0) {
      this.queue.shift()!.grant()
    }
  }
}
