import { Service, type Context } from "cordis"
import type { SessionStorage } from "toy-session-storage"
import { AgentSessionData } from "./agent.js"
import { snapshotChange, type SessionDataChange } from "./change.js"
import { SessionDataError } from "./error.js"
import {
  publishSessionDataChange,
  requireSessionPersistence,
  sessionPersistence,
} from "./internal.js"
import { ReadSessionData } from "./read.js"
import type { SessionDataConfig, SessionDataMode } from "./types.js"

declare module "cordis" {
  interface Context {
    sessionData: SessionData
  }
}

/** 同一个 Cordis 插件下的 Agent 运行数据和端侧读取数据入口。 */
export class SessionData extends Service {
  readonly agent: AgentSessionData
  readonly read: ReadSessionData
  private mode: SessionDataMode = "memory"
  private storage: SessionStorage | undefined

  /**
   * @param ctx Cordis 上下文；已经挂载 sessionStorage 时启用持久化模式。
   * @param config 数据库模式下完整读取 Session 和分页结果的软上限。
   */
  constructor(ctx: Context, config: SessionDataConfig = {}) {
    super(ctx, "sessionData")
    const maxReadSessions = positiveLimit(config.maxReadSessions ?? 100, "maxReadSessions")
    const maxReadPages = positiveLimit(config.maxReadPages ?? 100, "maxReadPages")
    this.read = new ReadSessionData(this, maxReadSessions, maxReadPages)
    this.agent = new AgentSessionData(this)
  }

  /** 启动时只选一次模式；数据库模式要求 sessionStorage 已经初始化。 */
  [Service.init](): void {
    // Cordis 可选服务通过反射查找；纯内存模式不需要注入数据库插件。
    const storage = this.ctx.reflect.get("sessionStorage") as SessionStorage | undefined
    if (storage !== undefined) {
      this.storage = storage
      this.mode = "persistent"
    }
  }

  /** @returns 初始化时选定的 memory 或 persistent 模式。 */
  getMode(): SessionDataMode {
    return this.mode
  }

  /**
   * 在存储状态完成更新后发布只读快照；监听器异常只记日志，不改变写入结果。
   *
   * @param change 已生效的 Session、Turn 或 Event 变化。
   * @returns 无返回值；监听器异步执行且不会阻塞当前写入。
   */
  [publishSessionDataChange](change: SessionDataChange): void {
    try {
      const snapshot = snapshotChange(change)
      // parallel 会执行所有监听器并汇总异常；不等待外部推送完成。
      void this.ctx.parallel("session-data/change", snapshot).catch((error: unknown) => {
        this.ctx.logger("session-data").warn("数据变化监听器执行失败：%o", error)
      })
    } catch (error) {
      // 通知快照失败也不能把已经更新的数据伪装成写入失败。
      this.ctx.logger("session-data").warn("数据变化监听器执行失败：%o", error)
    }
  }

  /** 包内使用的可选持久化服务；Symbol 不从包入口导出。 */
  [sessionPersistence](): SessionStorage | undefined {
    return this.storage
  }

  /**
   * @returns 已初始化的 Session 持久化服务。
   * @throws {SessionDataError} 纯内存模式调用数据库专属方法时抛出。
   */
  [requireSessionPersistence](): SessionStorage {
    if (this.storage === undefined) {
      throw new SessionDataError("storage-unavailable", "当前是纯内存模式，没有 Session 数据库")
    }
    return this.storage
  }
}

function positiveLimit(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new SessionDataError("invalid-input", `${name} 必须是正安全整数`)
  }
  return value
}

export default SessionData
