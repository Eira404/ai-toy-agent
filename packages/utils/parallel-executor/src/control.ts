import { ParallelError, type ParallelErrorCode } from "./error.js"

/** 显式解除监听与计时器，避免长期任务/重试在共享信号上累积监听。 */
export class Cancellation {
  private readonly controller = new AbortController()
  private readonly cleanups: (() => void)[] = []
  readonly signal = this.controller.signal

  constructor(signals: readonly (AbortSignal | undefined)[]) {
    // 原生 any 不向每个共享源信号逐项挂 EventTarget 监听，避免高并发监听警告。
    const linked = AbortSignal.any(
      signals.filter((signal): signal is AbortSignal => signal !== undefined),
    )
    const abort = () =>
      this.abort(
        linked.reason instanceof ParallelError
          ? linked.reason
          : new ParallelError("CANCELLED", "任务已取消", { cause: linked.reason }),
      )
    if (linked.aborted) {
      abort()
    } else {
      linked.addEventListener("abort", abort, { once: true })
      this.cleanups.push(() => linked.removeEventListener("abort", abort))
    }
  }

  abort(reason: unknown): void {
    if (!this.signal.aborted) {
      this.controller.abort(reason)
    }
  }

  deadline(ms: number | null, code: ParallelErrorCode): void {
    if (ms !== null) {
      const timer = setTimeout(() => this.abort(new ParallelError(code, `${code}: ${ms}ms`)), ms)
      this.cleanups.push(() => clearTimeout(timer))
    }
  }

  dispose(): void {
    for (const cleanup of this.cleanups.splice(0)) {
      cleanup()
    }
  }
}

export function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason)
      return
    }
    const finish = () => {
      signal.removeEventListener("abort", abort)
      clearTimeout(timer)
    }
    const abort = () => {
      finish()
      reject(signal.reason)
    }
    const timer = setTimeout(() => {
      finish()
      resolve()
    }, ms)
    signal.addEventListener("abort", abort, { once: true })
  })
}
