import { setImmediate as delay } from "node:timers/promises"

/**
 * 把非阻塞后处理从前台调用栈中分离，并吞住后台异常，避免形成 unhandled rejection。
 *
 * 调度只做进程内排队；持久化、租约和重试应由未来的 Repository/Queue 实现接管。
 */
export class BackgroundQueue {
  private readonly jobs = new Map<string, Promise<unknown>>()

  /**
   * 投递一个后台任务，立即返回。同一 id 同时最多运行一次。
   *
   * @param id 任务幂等键，例如 `turn-post:<sessionId>:<turnId>`。
   * @param execute 后台执行体；异常通过 `reportError` 上报，不向调用方传播。
   * @param reportError 后台失败回调。
   */
  dispatch(
    id: string,
    execute: () => Promise<unknown>,
    reportError: (id: string, error: unknown) => void,
  ): void {
    if (this.jobs.has(id)) {
      throw new Error(`后台任务已存在：${id}`)
    }
    // 让调用方先返回，后处理及写入等待均在下一轮事件循环开始。
    const job = delay()
      .then(() => execute())
      .catch((error: unknown) => reportError(id, error))
      .finally(() => this.jobs.delete(id))
    this.jobs.set(id, job)
  }

  /** 仅用于测试和优雅停机；前台 Turn 不应等待此方法。 */
  async waitForIdle(): Promise<void> {
    while (this.jobs.size > 0) {
      await Promise.all([...this.jobs.values()])
    }
  }
}
