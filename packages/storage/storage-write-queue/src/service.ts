import { Service, type Context } from "cordis"
import "toy-storage"
import { WriteQueueError } from "./error.js"
import type { JobWaiter, QueueEntry, QueueLane, ReceiptState } from "./internal.js"
import { retryDelay, shouldRetry } from "./retry.js"
import type {
  QueuedWriteJob,
  StorageWriteQueueConfig,
  WriteFlushOptions,
  WriteJobStatus,
  WriteQueueStats,
  WriteReceipt,
  WriteWaitOptions,
} from "./types.js"
import { assertQueueName, assertWaitOptions, jobKey, snapshotJob, targetKey } from "./validation.js"

declare module "cordis" {
  interface Context {
    storageWriteQueue: StorageWriteQueue
  }
}

/** 队列仅要求目标存储实例已有的 execute 方法；操作类型由该实例决定。 */
interface ExecutableStorage {
  execute(operation: unknown): Promise<unknown>
}

/**
 * 通过 ctx.storage 按 kind/name 找到命名存储实例的内存写入队列。
 * 每个逻辑队列保持 FIFO；同一目标的总写入并发受统一上限约束。
 */
export class StorageWriteQueue extends Service {
  static inject = ["storage"]

  private readonly lanes = new Map<string, QueueLane>()
  private readonly pendingByKey = new Map<string, QueueEntry>()
  private readonly receipts = new WeakMap<WriteReceipt, ReceiptState>()
  private readonly activeByTarget = new Map<string, number>()
  private readonly maxConcurrentPerTarget: number
  private readonly retryBaseMs: number
  private readonly retryMaxMs: number
  private nextLane = 0
  private scheduled = false
  private closed = false

  /**
   * @param ctx 提供命名存储注册中心的 Cordis 上下文。
   * @param config 写入并发和安全重试间隔。
   */
  constructor(ctx: Context, config: StorageWriteQueueConfig = {}) {
    super(ctx, "storageWriteQueue")
    this.maxConcurrentPerTarget = positiveInteger(
      config.maxConcurrentPerTarget ?? 1,
      "maxConcurrentPerTarget",
    )
    this.retryBaseMs = positiveInteger(config.retryBaseMs ?? 250, "retryBaseMs")
    this.retryMaxMs = positiveInteger(config.retryMaxMs ?? 30_000, "retryMaxMs")
    if (this.retryBaseMs > this.retryMaxMs) {
      throw new WriteQueueError("invalid-job", "retryBaseMs 不能大于 retryMaxMs")
    }
    ctx.effect(() => () => this.stop(), "storage-write-queue.stop")
  }

  /**
   * 接收一项待写操作。返回凭据仅表示内存队列已接收，不能视为数据库已提交。
   *
   * @param job 含任务 ID、逻辑队列、存储目标及目标操作的数据。
   * @returns 供状态查询及等待落库使用的不可变凭据。
   */
  enqueue<Operation>(job: QueuedWriteJob<Operation>): WriteReceipt {
    const receipts = this.enqueueMany([job])
    return receipts[0]!
  }

  /**
   * 先完整验证、复制一批任务，再同步入队；校验失败时不会接收其中任何一项。
   *
   * @param jobs 按各自 queueName 的输入顺序追加的任务。
   * @returns 与输入任务逐项对应的凭据。
   */
  enqueueMany<Operation>(jobs: readonly QueuedWriteJob<Operation>[]): readonly WriteReceipt[] {
    this.assertOpen()
    const snapshots = jobs.map(snapshotJob)
    const keys = new Set<string>()
    for (const job of snapshots) {
      const key = jobKey(job.queueName, job.jobId)
      if (keys.has(key) || this.pendingByKey.has(key)) {
        throw new WriteQueueError(
          "duplicate-job",
          `任务 '${job.queueName}/${job.jobId}' 已在队列中`,
        )
      }
      keys.add(key)
      this.requireTarget(job.target.kind, job.target.name)
    }

    const receipts: WriteReceipt[] = []
    for (const job of snapshots) {
      const receipt: WriteReceipt = Object.freeze({ queueName: job.queueName, jobId: job.jobId })
      const state: ReceiptState = {
        queueName: job.queueName,
        jobId: job.jobId,
        waiters: new Set(),
        status: "queued",
      }
      const entry: QueueEntry = {
        job,
        receipt,
        state,
        acceptedAt: Date.now(),
        failures: 0,
        retryTimer: undefined,
      }
      let lane = this.lanes.get(job.queueName)
      if (lane === undefined) {
        lane = { name: job.queueName, entries: [], head: 0, running: false }
        this.lanes.set(job.queueName, lane)
      }
      lane.entries.push(entry)
      this.pendingByKey.set(jobKey(job.queueName, job.jobId), entry)
      this.receipts.set(receipt, state)
      receipts.push(receipt)
    }
    if (receipts.length > 0) {
      this.schedule()
    }
    return receipts
  }

  /**
   * @param receipt 本队列实例在 enqueue/enqueueMany 时返回的凭据。
   * @returns 任务当前状态；committed 表示目标存储已经确认写入。
   */
  getStatus(receipt: WriteReceipt): WriteJobStatus {
    return this.requireReceipt(receipt).status
  }

  /**
   * 在外部修复错误后重新调度阻塞任务；提交状态不明时调用方必须先核对数据库。
   *
   * @param receipt 当前仍处于 blocked 状态的任务凭据。
   * @returns 重新进入排队状态后无返回值。
   */
  retryBlocked(receipt: WriteReceipt): void {
    this.assertOpen()
    const state = this.requireReceipt(receipt)
    if (state.status !== "blocked") {
      throw new WriteQueueError("invalid-job", "只有 blocked 任务可以手动重试")
    }
    const entry = this.pendingByKey.get(jobKey(state.queueName, state.jobId))
    if (entry?.receipt !== receipt) {
      throw new WriteQueueError("invalid-receipt", "阻塞任务已不在队列中")
    }
    state.status = "queued"
    delete state.lastError
    this.schedule()
  }

  /**
   * 等待指定任务确认提交；等待超时或取消不会改变任务的执行状态。
   *
   * @param receipt 需要等待的任务凭据。
   * @param options 本次等待的超时和取消信号。
   * @returns 目标 execute 成功完成后兑现的 Promise。
   */
  waitFor(receipt: WriteReceipt, options: WriteWaitOptions = {}): Promise<void> {
    assertWaitOptions(options)
    const state = this.requireReceipt(receipt)
    if (state.status === "committed") {
      return Promise.resolve()
    }
    if (state.status === "blocked") {
      return Promise.reject(blockedError(state))
    }
    if (options.signal?.aborted) {
      return Promise.reject(new WriteQueueError("wait-cancelled", "等待写入时已取消"))
    }
    return new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const cleanup = () => {
        state.waiters.delete(waiter)
        if (timer !== undefined) {
          clearTimeout(timer)
        }
        options.signal?.removeEventListener("abort", onAbort)
      }
      const waiter: JobWaiter = {
        resolve: () => {
          cleanup()
          resolve()
        },
        reject: (error) => {
          cleanup()
          reject(error)
        },
      }
      const onAbort = () => waiter.reject(new WriteQueueError("wait-cancelled", "等待写入时已取消"))
      state.waiters.add(waiter)
      if (options.timeoutMs !== undefined) {
        timer = setTimeout(
          () => waiter.reject(new WriteQueueError("wait-timeout", "等待写入超时")),
          options.timeoutMs,
        )
      }
      options.signal?.addEventListener("abort", onAbort, { once: true })
    })
  }

  /**
   * 等待调用瞬间已入队的任务；之后新加入的任务不延长本次等待。
   *
   * @param options 可选队列名、超时及取消信号。
   * @returns 捕获到的任务全部确认提交后兑现的 Promise。
   */
  async flush(options: WriteFlushOptions = {}): Promise<void> {
    assertWaitOptions(options)
    if (options.queueName !== undefined) {
      assertQueueName(options.queueName)
    }
    const receipts = [...this.pendingByKey.values()]
      .filter(
        (entry) => options.queueName === undefined || entry.job.queueName === options.queueName,
      )
      .map((entry) => entry.receipt)
    await Promise.all(receipts.map((receipt) => this.waitFor(receipt, options)))
  }

  /**
   * @param queueName 可选的逻辑队列名；省略时统计所有队列。
   * @returns 当前未确认任务的状态数量和最长等待时间。
   */
  getStats(queueName?: string): WriteQueueStats {
    if (queueName !== undefined) {
      assertQueueName(queueName)
    }
    const stats = {
      queued: 0,
      writing: 0,
      retrying: 0,
      blocked: 0,
      pending: 0,
      oldestPendingMs: undefined as number | undefined,
    }
    const now = Date.now()
    for (const entry of this.pendingByKey.values()) {
      if (queueName !== undefined && entry.job.queueName !== queueName) {
        continue
      }
      if (entry.state.status === "committed") {
        continue
      }
      stats[entry.state.status]++
      stats.pending++
      const age = now - entry.acceptedAt
      stats.oldestPendingMs = Math.max(stats.oldestPendingMs ?? 0, age)
    }
    return stats
  }

  /** 延迟到当前同步追加结束后再启动 worker，保证 enqueueMany 先全部入队。 */
  private schedule(): void {
    if (this.scheduled || this.closed) {
      return
    }
    this.scheduled = true
    queueMicrotask(() => {
      this.scheduled = false
      this.pump()
    })
  }

  /** 在每条队列的队首之间轮转，避免某个持续追加的队列独占同一目标。 */
  private pump(): void {
    if (this.closed) {
      return
    }
    while (true) {
      const lanes = [...this.lanes.values()]
      if (lanes.length === 0) {
        return
      }
      let selected: { lane: QueueLane; entry: QueueEntry; key: string } | undefined
      for (let offset = 0; offset < lanes.length; offset++) {
        const index = (this.nextLane + offset) % lanes.length
        const lane = lanes[index]!
        const entry = lane.entries[lane.head]
        if (lane.running || entry?.state.status !== "queued") {
          continue
        }
        const key = targetKey(entry.job.target.kind, entry.job.target.name)
        if ((this.activeByTarget.get(key) ?? 0) >= this.maxConcurrentPerTarget) {
          continue
        }
        selected = { lane, entry, key }
        this.nextLane = (index + 1) % lanes.length
        break
      }
      if (selected === undefined) {
        return
      }
      selected.lane.running = true
      selected.entry.state.status = "writing"
      this.activeByTarget.set(selected.key, (this.activeByTarget.get(selected.key) ?? 0) + 1)
      void this.run(selected.lane, selected.entry, selected.key)
    }
  }

  /** 执行一项任务；只在 execute 成功返回后从队列移除。 */
  private async run(lane: QueueLane, entry: QueueEntry, key: string): Promise<void> {
    try {
      const target = this.requireTarget(entry.job.target.kind, entry.job.target.name)
      await target.execute(entry.job.operation)
      entry.state.status = "committed"
      delete entry.state.lastError
      this.pendingByKey.delete(jobKey(entry.job.queueName, entry.job.jobId))
      lane.head++
      if (lane.head === lane.entries.length) {
        this.lanes.delete(lane.name)
      } else if (lane.head >= 1024) {
        lane.entries.splice(0, lane.head)
        lane.head = 0
      }
      for (const waiter of [...entry.state.waiters]) {
        waiter.resolve()
      }
    } catch (error) {
      entry.state.lastError = error
      entry.failures++
      if (!this.closed && shouldRetry(error)) {
        entry.state.status = "retrying"
        entry.retryTimer = setTimeout(
          () => {
            entry.retryTimer = undefined
            if (!this.closed && entry.state.status === "retrying") {
              entry.state.status = "queued"
              this.schedule()
            }
          },
          retryDelay(entry.failures, this.retryBaseMs, this.retryMaxMs),
        )
      } else {
        // 未知提交状态或永久错误保留在队首，防止后续写入越过它。
        entry.state.status = "blocked"
        for (const waiter of [...entry.state.waiters]) {
          waiter.reject(blockedError(entry.state))
        }
      }
    } finally {
      lane.running = false
      const active = (this.activeByTarget.get(key) ?? 1) - 1
      if (active === 0) {
        this.activeByTarget.delete(key)
      } else {
        this.activeByTarget.set(key, active)
      }
      this.schedule()
    }
  }

  /** 入队和执行时都检查目标，避免把任务交给已经卸载的插件实例。 */
  private requireTarget(kind: string, name: string): ExecutableStorage {
    const target = this.ctx.storage.tryGet(kind, name)
    if (target === undefined || typeof (target as { execute?: unknown }).execute !== "function") {
      throw new WriteQueueError(
        "target-unavailable",
        `存储目标 '${kind}/${name}' 未就绪或不支持 execute`,
      )
    }
    return target as ExecutableStorage
  }

  /** 凭据只能用于创建它的插件实例。 */
  private requireReceipt(receipt: WriteReceipt): ReceiptState {
    const state = this.receipts.get(receipt)
    if (state === undefined) {
      throw new WriteQueueError("invalid-receipt", "任务凭据不属于当前写入队列")
    }
    return state
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new WriteQueueError("queue-closed", "写入队列已关闭")
    }
  }

  /** Cordis 插件卸载时停止调度并通知等待者；内存队列不承诺重启后恢复。 */
  private stop(): void {
    this.closed = true
    for (const entry of this.pendingByKey.values()) {
      if (entry.retryTimer !== undefined) {
        clearTimeout(entry.retryTimer)
        entry.retryTimer = undefined
      }
      entry.state.status = "blocked"
      entry.state.lastError = new WriteQueueError("queue-closed", "写入队列已关闭")
      for (const waiter of [...entry.state.waiters]) {
        waiter.reject(blockedError(entry.state))
      }
    }
  }
}

/** 将阻塞原因保留在错误 cause 中，供调用方诊断而不丢失待写任务。 */
function blockedError(state: ReceiptState): WriteQueueError {
  return new WriteQueueError("job-blocked", `任务 '${state.queueName}/${state.jobId}' 写入受阻`, {
    cause: state.lastError,
  })
}

/** 配置仅接受正安全整数，避免零并发或无限重试循环。 */
function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new WriteQueueError("invalid-job", `${name} 必须是正安全整数`)
  }
  return value
}

export default StorageWriteQueue
