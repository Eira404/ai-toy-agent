import { addAbortListener } from "node:events"
import { SessionDataError } from "toy-session-data"
import type { SessionRecord } from "toy-session-storage"

/** 单个 active Session 的 Turn 执行队列和关闭门闩。 */
export class SessionRuntime {
  private tail = Promise.resolve()
  private closeRequested = false
  private closing: Promise<SessionRecord> | undefined

  /**
   * 串行运行一轮 Turn。排队取消立即拒绝调用，运行中取消等执行器退出再释放队列。
   *
   * @param execute 已轮到执行时调用的函数。
   * @param signal 调用方控制的本轮取消信号。
   * @returns 本轮执行结果。取消时以 `signal.reason` 拒绝。
   */
  async runTurn<T>(execute: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted()
    this.assertAcceptingTurns()
    return new Promise<T>((resolve, reject) => {
      // 此监听只负责排队期间的取消。开始执行后，由 Agent 通过同一个 signal 协作退出。
      const waitingAbort =
        signal === undefined ? undefined : addAbortListener(signal, () => reject(signal.reason))
      const task = this.tail.then(() => {
        waitingAbort?.[Symbol.dispose]()
        signal?.throwIfAborted()
        this.assertAcceptingTurns()
        return execute()
      })
      // 队列等待实际任务结束。即使外部已收到排队取消，后续任务也要依序开始。
      this.tail = task.then(
        (result) => {
          if (signal?.aborted) {
            reject(signal.reason)
          } else {
            resolve(result)
          }
        },
        (error: unknown) => reject(signal?.aborted ? signal.reason : error),
      )
    })
  }

  /** 同步关掉 Turn 入口，等待已开始的 Turn 退出，再合并执行一次状态更新。 */
  requestClose(beginClosing: () => Promise<SessionRecord>): Promise<SessionRecord> {
    this.closeRequested = true
    this.closing ??= this.tail.then(beginClosing).catch((error: unknown) => {
      // 状态更新失败时保留门闩，后续关闭申请可以重试更新。
      this.closing = undefined
      throw error
    })
    return this.closing
  }

  private assertAcceptingTurns(): void {
    if (this.closeRequested) {
      throw new SessionDataError("invalid-state", "Session 已申请关闭")
    }
  }
}
