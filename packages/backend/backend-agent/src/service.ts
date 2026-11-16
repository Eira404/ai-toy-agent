import { Service, type Context } from "cordis"
import "toy-backend-http"
import type { CreateSessionInput, RunTurnInput, RunTurnResult } from "toy-session"
import type { SessionHistory } from "toy-session-data"
import type {
  ListSessionsInput,
  ListTurnHistoryInput,
  Page,
  SessionCursor,
  SessionRecord,
  TurnHistory,
} from "toy-session-storage"

declare module "cordis" {
  interface Context {
    agentBackend: AgentBackendService
  }
}

/**
 * Agent 后端门面：把会话生命周期、对话调用与读取收敛成统一接口，并以 HTTP 路由形式
 * 注册到 `toy-backend-http`（`/agentBackend/*`）。
 *
 * 它只转发 `ctx.session` 与 `ctx.sessionData`，不建根 Context、不编排、不解析全局配置；
 * 依赖通过 `inject` 声明，由开发者负责按序挂载。真正的 Agent 循环（`toy-agent-loop`）
 * 与模型路由由开发者另行挂载。
 */
export class AgentBackendService extends Service {
  static inject = ["session", "sessionData", "http"]

  constructor(ctx: Context) {
    super(ctx, "agentBackend")
    ctx.effect(() => this.registerRoutes(), "agentBackend.routes")
  }

  /** 创建 active Session；`payload` 透传给 `session.preprocessing` 并写入 `payload.initial`。 */
  createSession(input: CreateSessionInput): Promise<string> {
    return this.ctx.session.createSession(input)
  }

  /** 按 ID 读 Session；persistent 模式内存未命中时补库。 */
  getSession(sessionId: string): Promise<SessionRecord | undefined> {
    return this.ctx.sessionData.read.getSession(sessionId)
  }

  /** 读某用户设备的 active Session。 */
  getActiveSession(userId: string, deviceId: string): Promise<SessionRecord | undefined> {
    return this.ctx.sessionData.read.getActiveSession(userId, deviceId)
  }

  /** 按创建时间倒序分页列出 Session。 */
  listSessions(input: ListSessionsInput): Promise<Page<SessionRecord, SessionCursor>> {
    return this.ctx.sessionData.read.listSessions(input)
  }

  /** 申请关闭；阻塞 Turn 写完、后处理后台执行，返回 closing/closed 记录。 */
  closeSession(sessionId: string): Promise<SessionRecord> {
    return this.ctx.session.requestClose(sessionId)
  }

  /** 串行执行一轮；`result` 在 `toy-agent-loop` 下是 `AgentResult`。 */
  runTurn(sessionId: string, input: RunTurnInput): Promise<RunTurnResult> {
    return this.ctx.session.runTurn(sessionId, input)
  }

  /** 运行期完整历史（同步，只读驻留内存，不隐式补库）。 */
  getHistory(sessionId: string): SessionHistory {
    return this.ctx.sessionData.agent.getHistory(sessionId)
  }

  /** 读一个 Turn 及其全部 Event（可补库）。 */
  getTurnHistory(sessionId: string, turnId: string): Promise<TurnHistory> {
    return this.ctx.sessionData.read.getTurnHistory(sessionId, turnId)
  }

  /** 按 Turn 分页读历史，每个 Turn 的 Event 不被截断。 */
  listTurnHistory(input: ListTurnHistoryInput): Promise<Page<TurnHistory, number>> {
    return this.ctx.sessionData.read.listTurnHistory(input)
  }

  /** 等待 Session 后处理收尾；示例、测试或宿主停机时调用。 */
  waitForPostprocessing(): Promise<void> {
    return this.ctx.session.waitForPostprocessing()
  }

  /** 把门面接口注册为 `/agentBackend/*` 的 HTTP 路由；卸载时一并注销。 */
  private registerRoutes(): () => void {
    const { http } = this.ctx
    const disposers = [
      http.post("/agentBackend/createSession", (c) =>
        this.createSession(c.body as CreateSessionInput),
      ),
      http.get("/agentBackend/getSession/:sessionId", (c) => this.getSession(c.params.sessionId!)),
      http.get("/agentBackend/getActiveSession/:userId/:deviceId", (c) =>
        this.getActiveSession(c.params.userId!, c.params.deviceId!),
      ),
      http.get("/agentBackend/listSessions/:userId/:deviceId", (c) => {
        const limit = parseQueryInt(c.query, "limit")
        const beforeCreatedAt = c.query.get("beforeCreatedAt")
        const beforeSessionId = c.query.get("beforeSessionId")
        return this.listSessions({
          userId: c.params.userId!,
          deviceId: c.params.deviceId!,
          ...(limit === undefined ? {} : { limit }),
          ...(beforeCreatedAt === null || beforeSessionId === null
            ? {}
            : { before: { createdAt: beforeCreatedAt, sessionId: beforeSessionId } }),
        })
      }),
      http.post("/agentBackend/closeSession/:sessionId", (c) =>
        this.closeSession(c.params.sessionId!),
      ),
      http.post("/agentBackend/runTurn/:sessionId", (c) =>
        this.runTurn(c.params.sessionId!, { ...(c.body as RunTurnInput), signal: c.signal }),
      ),
      http.sse("/agentBackend/runTurnStream/:sessionId", async (c, emit) => {
        await this.runTurn(c.params.sessionId!, {
          ...(c.body as RunTurnInput),
          signal: c.signal,
          onEvent: emit,
        })
      }),
      http.get("/agentBackend/getHistory/:sessionId", (c) => this.getHistory(c.params.sessionId!)),
      http.get("/agentBackend/getTurnHistory/:sessionId/:turnId", (c) =>
        this.getTurnHistory(c.params.sessionId!, c.params.turnId!),
      ),
      http.get("/agentBackend/listTurnHistory/:sessionId", (c) => {
        const limit = parseQueryInt(c.query, "limit")
        const beforeTurnNo = parseQueryInt(c.query, "beforeTurnNo")
        return this.listTurnHistory({
          sessionId: c.params.sessionId!,
          ...(limit === undefined ? {} : { limit }),
          ...(beforeTurnNo === undefined ? {} : { beforeTurnNo }),
        })
      }),
      http.post("/agentBackend/waitForPostprocessing", () => this.waitForPostprocessing()),
    ]
    return () => {
      for (const dispose of disposers) {
        dispose()
      }
    }
  }
}

/** 解析整数查询参数；缺失或非法时返回 undefined。 */
function parseQueryInt(query: URLSearchParams, name: string): number | undefined {
  const raw = query.get(name)
  if (raw === null) {
    return undefined
  }
  const value = Number(raw)
  return Number.isSafeInteger(value) ? value : undefined
}

export default AgentBackendService
