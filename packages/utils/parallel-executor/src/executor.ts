import { AsyncLocalStorage } from "node:async_hooks"
import { randomUUID } from "node:crypto"
import {
  integer,
  invalid,
  label,
  resolvePolicy,
  resolvePool,
  timeout,
  type ResolvedPolicy,
} from "./config.js"
import { Cancellation, wait } from "./control.js"
import { ParallelBatchError, ParallelError } from "./error.js"
import { TaskPool } from "./pool.js"
import type {
  MapOptions,
  MapTaskContext,
  ParallelExecutorConfig,
  ParallelStats,
  RunOptions,
  TaskContext,
  TaskPoolConfig,
  TaskResult,
  WaitForIdleOptions,
} from "./types.js"

interface Frame {
  readonly pool: string
  readonly signal: AbortSignal
  active: boolean
}

type Worker<T, R> = (item: T, context: MapTaskContext) => R | PromiseLike<R>

/** 内部实现；业务只能通过 Cordis 服务调用。 */
export class Executor {
  private readonly pools = new Map<string, TaskPool>()
  private readonly storage = new AsyncLocalStorage<readonly Frame[]>()
  private readonly closing = new AbortController()
  private readonly batches = new Set<Cancellation>()
  private readonly idleWaiters = new Set<() => void>()
  private readonly defaultConcurrency: number
  private activeTasks = 0
  private closed = false

  constructor(config: ParallelExecutorConfig) {
    this.defaultConcurrency = integer(config.defaultMapConcurrency ?? 4, "defaultMapConcurrency")
    // 先校验所有初始化池，避免无效配置留下半初始化状态。
    const entries = Object.entries(config.pools ?? {}).map(
      ([name, value]) => [label(name, "pool"), resolvePool(value)] as const,
    )
    for (const [name, value] of entries) {
      this.pools.set(name, new TaskPool(value))
    }
  }

  registerPool(name: string, config: TaskPoolConfig): void {
    this.assertOpen()
    const key = label(name, "pool")
    const resolved = resolvePool(config)
    const pool = this.pools.get(key)
    if (pool === undefined) {
      this.pools.set(key, new TaskPool(resolved))
    } else {
      pool.configure(resolved)
    }
  }

  hasPool(name: string): boolean {
    return this.pools.has(label(name, "pool"))
  }

  stats(name?: string): ParallelStats {
    const entries =
      name === undefined
        ? [...this.pools.entries()]
        : [[label(name, "pool"), this.requirePool(name)] as const]
    return {
      activeBatches: this.batches.size,
      pools: Object.fromEntries(entries.map(([key, pool]) => [key, pool.snapshot()])),
    }
  }

  run<R>(task: (context: TaskContext) => R | PromiseLike<R>, options: RunOptions): Promise<R> {
    return this.execute(task, options)
  }

  private async execute<R>(
    task: (context: TaskContext) => R | PromiseLike<R>,
    options: RunOptions,
    onFailure?: (error: unknown) => void,
  ): Promise<R> {
    this.assertOpen()
    if (typeof task !== "function") {
      invalid("task 必须是尚未启动的函数")
    }
    const key = label(options.pool, "pool")
    const pool = this.requirePool(key)
    const parents = this.parents(key)
    const policy = resolvePolicy(options, pool.config)
    const taskId = options.taskId === undefined ? randomUUID() : label(options.taskId, "taskId")
    if (options.batchId !== undefined) {
      label(options.batchId, "batchId")
    }
    const identity = {
      pool: key,
      taskId,
      ...(options.batchId === undefined ? {} : { batchId: options.batchId }),
      ...(options.name === undefined ? {} : { name: options.name }),
    }
    const control = new Cancellation([
      this.closing.signal,
      options.signal,
      ...parents.map((parent) => parent.signal),
    ])
    control.deadline(policy.totalTimeoutMs, "TOTAL_TIMEOUT")
    this.activeTasks++
    pool.submitted++
    let attempts = 0
    try {
      while (true) {
        control.signal.throwIfAborted()
        const release = await pool.acquire(control.signal, policy.queueTimeoutMs)
        let value: R | undefined
        let failed = false
        let failure: unknown
        const attempt = new Cancellation([control.signal])
        attempt.deadline(policy.attemptTimeoutMs, "ATTEMPT_TIMEOUT")
        const frame: Frame = { pool: key, signal: attempt.signal, active: true }
        try {
          control.signal.throwIfAborted()
          attempts++
          pool.attemptsStarted++
          value = await this.storage.run([...parents, frame], () =>
            task({
              ...identity,
              attempt: attempts,
              signal: attempt.signal,
            }),
          )
          attempt.signal.throwIfAborted()
        } catch (error) {
          failed = true
          failure = attempt.signal.aborted ? attempt.signal.reason : error
        } finally {
          frame.active = false
          attempt.dispose()
        }
        let delay: number | undefined
        try {
          control.signal.throwIfAborted()
          if (!failed) {
            pool.succeeded++
            return value as R
          }
          delay = this.retryDelay(failure, policy, key, taskId, attempts)
          if (delay === undefined) {
            throw failure
          }
        } catch (cause) {
          // 严格批次必须先移除同批队列，再释放名额，防止失败后又启动兄弟任务。
          onFailure?.(
            new ParallelError(
              cause instanceof ParallelError ? cause.code : "TASK_FAILED",
              `任务 '${taskId}' 执行失败`,
              { ...identity, attempts, cause },
            ),
          )
          throw cause
        } finally {
          release()
        }
        pool.retryWaiting++
        try {
          await wait(delay, control.signal)
        } finally {
          pool.retryWaiting--
        }
      }
    } catch (cause) {
      const error = new ParallelError(
        cause instanceof ParallelError ? cause.code : "TASK_FAILED",
        `任务 '${taskId}' 执行失败`,
        { ...identity, attempts, cause },
      )
      onFailure?.(error)
      if (error.code === "CANCELLED" || error.code === "SERVICE_CLOSED") {
        pool.cancelled++
      } else {
        pool.failed++
      }
      throw error
    } finally {
      control.dispose()
      this.activeTasks--
      this.notifyIdle()
    }
  }

  async map<T, R>(items: readonly T[], worker: Worker<T, R>, options: MapOptions): Promise<R[]> {
    const results = await this.batch(items, worker, options, false)
    return results.map((result) => {
      if (result.status !== "fulfilled") {
        throw new Error("严格批次未在失败时拒绝")
      }
      return result.value
    })
  }

  mapSettled<T, R>(
    items: readonly T[],
    worker: Worker<T, R>,
    options: MapOptions,
  ): Promise<TaskResult<R>[]> {
    return this.batch(items, worker, options, true)
  }

  waitForIdle(options: WaitForIdleOptions = {}): Promise<void> {
    return new Promise((resolve, reject) => {
      const signal = options.signal
      if (signal?.aborted) {
        reject(new ParallelError("CANCELLED", "等待空闲已取消", { cause: signal.reason }))
        return
      }
      if (this.isIdle()) {
        resolve()
        return
      }
      const done = () => {
        this.idleWaiters.delete(done)
        signal?.removeEventListener("abort", abort)
        resolve()
      }
      const abort = () => {
        this.idleWaiters.delete(done)
        signal?.removeEventListener("abort", abort)
        reject(new ParallelError("CANCELLED", "等待空闲已取消", { cause: signal?.reason }))
      }
      this.idleWaiters.add(done)
      signal?.addEventListener("abort", abort, { once: true })
    })
  }

  async stop(): Promise<void> {
    this.closed = true
    this.closing.abort(new ParallelError("SERVICE_CLOSED", "执行器已关闭"))
    await this.waitForIdle()
  }

  private async batch<T, R>(
    items: readonly T[],
    worker: Worker<T, R>,
    options: MapOptions,
    settled: boolean,
  ): Promise<TaskResult<R>[]> {
    this.assertOpen()
    if (!Array.isArray(items) || typeof worker !== "function") {
      invalid("items 必须是数组，worker 必须是函数")
    }
    const key = label(options.pool, "pool")
    const pool = this.requirePool(key)
    const parents = this.parents(key)
    const concurrency = integer(
      options.concurrency ?? Math.min(this.defaultConcurrency, pool.config.maxConcurrency),
      "concurrency",
    )
    // 预先校验调用级策略，但后续每项提交仍读取当时的池默认值。
    resolvePolicy(options.task ?? {}, pool.config)
    const taskPolicy =
      options.task === undefined
        ? {}
        : { ...options.task, ...(options.task.retry && { retry: { ...options.task.retry } }) }
    const batchId = options.batchId === undefined ? randomUUID() : label(options.batchId, "batchId")
    const duration = timeout(options.batchTimeoutMs ?? null, "batchTimeoutMs")
    const control = new Cancellation([
      this.closing.signal,
      options.signal,
      ...parents.map((parent) => parent.signal),
    ])
    control.deadline(duration, "TOTAL_TIMEOUT")
    this.batches.add(control)
    const input = [...items]
    const results = new Array<TaskResult<R>>(input.length)
    const attemptsByIndex = new Array<number>(input.length).fill(0)
    let next = 0
    let firstFailure: { index: number; taskId: string; error: unknown } | undefined
    const fail = (index: number, taskId: string, error: unknown) => {
      if (!settled && firstFailure === undefined) {
        firstFailure = { index, taskId, error }
        control.abort(
          new ParallelError("CANCELLED", "同批任务失败，取消其余任务", { cause: error }),
        )
      }
    }
    const runner = async () => {
      while (next < input.length && !control.signal.aborted) {
        const index = next++
        const taskId = `${batchId}:${index}`
        try {
          const value = await this.execute(
            (context) => {
              attemptsByIndex[index] = context.attempt
              return worker(input[index]!, { ...context, batchId, index })
            },
            {
              ...taskPolicy,
              pool: key,
              taskId,
              batchId,
              signal: control.signal,
              ...(options.name === undefined ? {} : { name: options.name }),
            },
            (error) => fail(index, taskId, error),
          )
          // 实际尝试次数通过本项 wrapper 在每次启动时记录。
          results[index] = {
            status: "fulfilled",
            taskId,
            index,
            attempts: attemptsByIndex[index]!,
            value,
          }
        } catch (error) {
          const attempts = error instanceof ParallelError ? error.attempts : 0
          results[index] = control.signal.aborted
            ? { status: "cancelled", taskId, index, attempts, reason: error }
            : { status: "rejected", taskId, index, attempts, error }
          fail(index, taskId, error)
        }
      }
    }
    try {
      await Promise.all(Array.from({ length: Math.min(concurrency, input.length) }, () => runner()))
      if (!settled) {
        if (firstFailure !== undefined) {
          throw new ParallelBatchError(firstFailure.index, {
            batchId,
            taskId: firstFailure.taskId,
            pool: key,
            cause: firstFailure.error,
            attempts: firstFailure.error instanceof ParallelError ? firstFailure.error.attempts : 0,
          })
        }
        control.signal.throwIfAborted()
      }
      for (let index = 0; index < input.length; index++) {
        results[index] ??= {
          status: "cancelled",
          taskId: `${batchId}:${index}`,
          index,
          attempts: 0,
          reason: control.signal.reason,
        }
      }
      return results
    } finally {
      control.dispose()
      this.batches.delete(control)
      this.notifyIdle()
    }
  }

  private retryDelay(
    error: unknown,
    policy: ResolvedPolicy,
    pool: string,
    taskId: string,
    attempt: number,
  ): number | undefined {
    const retry = policy.retry
    if (
      !retry ||
      attempt >= retry.maxAttempts ||
      !retry.shouldRetry(error, { pool, taskId, attempt })
    ) {
      return undefined
    }
    const cap = Math.min(retry.maxDelayMs, retry.baseDelayMs * 2 ** (attempt - 1))
    const backoff = retry.jitter ? Math.floor(Math.random() * (cap + 1)) : cap
    const requested = retry.retryAfterMs?.(error)
    if (requested !== undefined && (!Number.isFinite(requested) || requested < 0)) {
      invalid("retryAfterMs 返回值必须是非负有限毫秒数")
    }
    return timeout(Math.max(1, backoff, Math.ceil(requested ?? 0)), "retry delay")!
  }

  private parents(pool: string): readonly Frame[] {
    const parents = (this.storage.getStore() ?? []).filter((frame) => frame.active)
    if (parents.some((frame) => frame.pool === pool)) {
      throw new ParallelError("POOL_REENTRY", `不允许嵌套进入任务池 '${pool}'`, { pool })
    }
    return parents
  }

  private requirePool(name: string): TaskPool {
    const key = label(name, "pool")
    const pool = this.pools.get(key)
    if (pool === undefined) {
      throw new ParallelError("UNKNOWN_POOL", `任务池 '${key}' 尚未注册`, { pool: key })
    }
    return pool
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new ParallelError("SERVICE_CLOSED", "执行器已关闭")
    }
  }

  private isIdle(): boolean {
    return this.activeTasks === 0 && this.batches.size === 0
  }

  private notifyIdle(): void {
    if (this.isIdle()) {
      for (const done of [...this.idleWaiters]) {
        done()
      }
    }
  }
}
