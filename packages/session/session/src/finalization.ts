import { setImmediate } from "node:timers/promises"
import type { LifecycleGraph } from "toy-lifecycle"
import type { SessionData } from "toy-session-data"
import { closingPayload, workflowOutput } from "./payload.js"
import type { SessionPostprocessingContext } from "./types.js"

/** 按旧 sessionId 管理进程内后台收尾任务。 */
export class SessionFinalization {
  private readonly jobs = new Map<string, Promise<void>>()

  constructor(
    private readonly agent: SessionData["agent"],
    private readonly graph: LifecycleGraph<SessionPostprocessingContext>,
    private readonly reportError: (sessionId: string, error: unknown) => void,
  ) {}

  /** 投递 closing Session 的后台任务。同一 Session 同时最多运行一次。 */
  dispatch(sessionId: string): void {
    if (this.jobs.has(sessionId)) {
      return
    }
    // 让关闭申请先返回，后处理及写入等待均在下一轮事件循环开始。
    const job = setImmediate()
      .then(() => this.finish(sessionId))
      .catch((error: unknown) => this.reportError(sessionId, error))
      .finally(() => this.jobs.delete(sessionId))
    this.jobs.set(sessionId, job)
  }

  /** 等待已投递的任务收尾，供示例、测试和宿主停机使用。 */
  async waitForIdle(): Promise<void> {
    while (this.jobs.size > 0) {
      await Promise.all([...this.jobs.values()])
    }
  }

  private async finish(sessionId: string): Promise<void> {
    await this.agent.waitForWrites(sessionId)
    const history = this.agent.getHistory(sessionId)
    const result = await this.graph.run(history)
    await this.agent.finishClosingSession(sessionId, {
      payload: closingPayload(history.session, workflowOutput(result)),
      version: 1,
    })
  }
}
