import { AdminError } from "./error.js"
import type { AdminExecutionState, AdminWaitOptions, AdminWaitStatus } from "./types.js"
import { objectInput, positive } from "./validation.js"

/**
 * 一次 execute 的等待与业务状态。取消只结束调用方等待，原 Promise 仍由总包观察。
 * 返回任务 ID/事件源后立即完成该调用，不跟踪后续任务或网络连接。
 */
export class Invocation {
  readonly controller = new AbortController()
  executionState: AdminExecutionState = "not-started"
  waitStatus: AdminWaitStatus = "waiting"
  private readonly releases: (() => void)[] = []

  constructor(
    readonly executionId: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ) {
    const timer = setTimeout(() => this.abort("timeout"), timeoutMs)
    this.releases.push(() => clearTimeout(timer))
    if (signal !== undefined) {
      this.follow(signal)
    }
  }

  /** 订阅外部/插件生命周期信号；忽略外部 reason，防止秘密被带进错误消息。 */
  follow(signal: AbortSignal): void {
    const listener = (): void => this.abort("cancelled")
    signal.addEventListener("abort", listener, { once: true })
    this.releases.push(() => signal.removeEventListener("abort", listener))
    if (signal.aborted) {
      listener()
    }
  }

  check(): void {
    this.controller.signal.throwIfAborted()
  }

  /** Promise.race 不释放执行容量；调用真正 settle 时才由 Inflight.release 收尾。 */
  async wait<T>(work: Promise<T>): Promise<T> {
    let remove: (() => void) | undefined
    const interrupted = new Promise<never>((_resolve, reject) => {
      const listener = (): void => reject(this.abortError())
      this.controller.signal.addEventListener("abort", listener, { once: true })
      remove = () => this.controller.signal.removeEventListener("abort", listener)
      if (this.controller.signal.aborted) {
        listener()
      }
    })
    try {
      return await Promise.race([work, interrupted])
    } finally {
      remove?.()
    }
  }

  complete(): void {
    if (this.waitStatus === "waiting") {
      this.waitStatus = "completed"
    }
    for (const release of this.releases) {
      release()
    }
  }

  abort(code: "timeout" | "cancelled"): void {
    if (this.controller.signal.aborted) {
      return
    }
    this.waitStatus = code
    this.controller.abort(this.abortError())
  }

  private abortError(): AdminError {
    return new AdminError(
      this.waitStatus === "timeout" ? "timeout" : "cancelled",
      "管理调用等待已结束，业务是否停止需根据执行状态确认",
      { executionId: this.executionId, executionState: this.executionState },
    )
  }
}

/** 有界在途调用集合，无等待队列。宿主先 stop，再 waitForIdle，最后卸载插件。 */
export class Inflight {
  private readonly active = new Set<Invocation>()
  private readonly idle = new Set<() => void>()
  private accepting = true

  constructor(private readonly maxConcurrent: number) {}

  create(id: string, timeoutMs: number, signal?: AbortSignal): Invocation {
    if (!this.accepting) {
      throw new AdminError("operation-unavailable", "管理员服务已停止接收调用")
    }
    if (this.active.size >= this.maxConcurrent) {
      throw new AdminError("busy", "管理员并发调用已达上限")
    }
    const invocation = new Invocation(id, timeoutMs, signal)
    this.active.add(invocation)
    return invocation
  }

  release(invocation: Invocation): void {
    invocation.complete()
    this.active.delete(invocation)
    if (this.active.size === 0) {
      for (const resolve of [...this.idle]) {
        resolve()
      }
    }
  }

  stop(): void {
    this.accepting = false
  }

  close(): void {
    this.stop()
    for (const invocation of this.active) {
      invocation.abort("cancelled")
    }
  }

  /** 超时/取消只退出本次 idle 等待，不删除仍然运行的调用。 */
  async waitForIdle(options: AdminWaitOptions = {}): Promise<void> {
    objectInput(options)
    if (options.timeoutMs !== undefined) {
      positive(options.timeoutMs, "timeoutMs")
    }
    if (options.signal !== undefined && !(options.signal instanceof AbortSignal)) {
      throw new AdminError("invalid-input", "signal 必须是 AbortSignal")
    }
    if (options.signal?.aborted) {
      throw new AdminError("cancelled", "等待空闲已取消")
    }
    if (this.active.size === 0) {
      return
    }
    await new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const finish = (error?: AdminError): void => {
        if (timer !== undefined) {
          clearTimeout(timer)
        }
        this.idle.delete(done)
        options.signal?.removeEventListener("abort", aborted)
        if (error === undefined) {
          resolve()
        } else {
          reject(error)
        }
      }
      const done = (): void => finish()
      const aborted = (): void => finish(new AdminError("cancelled", "等待空闲已取消"))
      this.idle.add(done)
      options.signal?.addEventListener("abort", aborted, { once: true })
      if (options.timeoutMs !== undefined) {
        timer = setTimeout(
          () => finish(new AdminError("timeout", "等待空闲已超时")),
          options.timeoutMs,
        )
      }
      if (options.signal?.aborted) {
        aborted()
      }
    })
  }
}
