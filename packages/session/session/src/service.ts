import { Service, type Context } from "cordis"
import { LifecycleGraph } from "toy-lifecycle"
import { SessionDataError, type SessionData } from "toy-session-data"
import type { SessionRecord, TurnHistory } from "toy-session-storage"
import { SessionFinalization } from "./finalization.js"
import { workflowOutput } from "./payload.js"
import { SessionRuntime } from "./runtime.js"
import type {
  CreateSessionInput,
  ModelHistoryMessage,
  RunTurnInput,
  RunTurnResult,
  SessionPayload,
  SessionPhase,
  SessionPostprocessingContext,
  SessionPreprocessingContext,
  TurnConfig,
  TurnExecutor,
  UserMessage,
} from "./types.js"

declare module "cordis" {
  interface Context {
    session: ToySession
  }
}

/** Agent 的 Session 入口，编排创建、Turn 和两段式关闭。 */
export class ToySession extends Service {
  static inject = ["sessionData"]

  private readonly data: SessionData
  private executorRegistration: { readonly executeTurn: TurnExecutor } | undefined
  private readonly runtimes = new Map<string, SessionRuntime>()
  private readonly creating = new Set<string>()
  private readonly preGraph = new LifecycleGraph<SessionPreprocessingContext>()
  private readonly postGraph = new LifecycleGraph<SessionPostprocessingContext>()
  private readonly finalization: SessionFinalization

  /** 在创建 Session 前运行的工作流注册入口。 */
  readonly preprocessing: SessionPhase<SessionPreprocessingContext> = {
    register: (processor) => this.preGraph.register(processor),
  }

  /** 在 Session 进入 closing 后后台运行的工作流注册入口。 */
  readonly postprocessing: SessionPhase<SessionPostprocessingContext> = {
    register: (processor) => this.postGraph.register(processor),
  }

  /**
   * 在 SessionData 就绪后挂载。Agent 插件可在之后调用 `registerTurnExecutor`。
   *
   * @param ctx 已挂载 SessionData 的 Cordis 上下文。
   */
  constructor(ctx: Context) {
    super(ctx, "session")
    this.data = ctx.sessionData
    this.finalization = new SessionFinalization(this.data.agent, this.postGraph, (id, error) => {
      this.ctx.logger("session").warn("Session %s 后处理失败：%o", id, error)
    })
  }

  /**
   * 注册当前服务使用的唯一 Turn 执行器。Agent 插件可以用 `ctx.effect` 管理注册周期。
   *
   * @param executeTurn Agent 执行一轮的方法。每轮开始时选定该执行器。
   * @returns 可重复调用的注销函数，只影响尚未开始的 Turn。
   * @throws {SessionDataError} 执行器不是函数，或当前已有注册。
   * @example
   * ctx.effect(() => ctx.session.registerTurnExecutor((input) => agent.executeTurn(input)))
   */
  registerTurnExecutor(executeTurn: TurnExecutor): () => void {
    if (typeof executeTurn !== "function") {
      throw new SessionDataError("invalid-input", "Turn 执行器必须是函数")
    }
    if (this.executorRegistration !== undefined) {
      throw new SessionDataError("invalid-state", "Turn 执行器已注册")
    }
    const registration = { executeTurn }
    this.executorRegistration = registration
    return () => {
      // 按注册记录注销，旧的注销函数不会影响后来注册的同一个函数。
      if (this.executorRegistration === registration) {
        this.executorRegistration = undefined
      }
    }
  }

  /**
   * 完成预处理并创建 active Session。同一用户设备同时只能创建一个 Session。
   *
   * @param input 用户、玩偶设备和可选的初始 JSON 数据。
   * @returns 已完成预处理的 active Session ID。预处理失败时以原错误拒绝。
   */
  async createSession({ userId, deviceId, payload }: CreateSessionInput): Promise<string> {
    if (
      typeof userId !== "string" ||
      userId.trim().length === 0 ||
      typeof deviceId !== "string" ||
      deviceId.trim().length === 0
    ) {
      throw new SessionDataError("invalid-input", "userId 和 deviceId 必须是非空字符串")
    }
    const owner = JSON.stringify([userId, deviceId])
    if (this.creating.has(owner)) {
      throw new SessionDataError("active-session-exists", "该用户设备正在创建 Session")
    }

    const initial = structuredClone(payload ?? {})
    this.creating.add(owner)
    try {
      if ((await this.data.read.getActiveSession(userId, deviceId)) !== undefined) {
        throw new SessionDataError("active-session-exists", "该用户设备已有 active Session")
      }
      const result = await this.preGraph.run({ userId, deviceId, payload: initial })
      const sessionPayload: SessionPayload = {
        kind: "toy-session",
        initial,
        preprocessing: workflowOutput(result),
      }
      const session = await this.data.agent.createSession({
        userId,
        deviceId,
        payload: sessionPayload,
        version: 1,
      })
      return session.sessionId
    } finally {
      this.creating.delete(owner)
    }
  }

  /**
   * 为 active Session 排队执行一轮。选定已注册的执行器后，创建 Turn 并写入用户消息。
   *
   * @param sessionId 由 `createSession` 返回的 ID，或已经恢复到 Agent 内存的 Session ID。
   * @param input 本轮用户消息、可选执行配置和取消信号。文本必须包含非空白内容。
   * @returns 本轮 Turn ID 和执行器返回值。取消时以 `signal.reason` 拒绝。
   * @throws {SessionDataError} Session 不可用、已经申请关闭、执行器尚未注册或输入无效。
   */
  async runTurn(
    sessionId: string,
    { message, config, signal, onEvent }: RunTurnInput,
  ): Promise<RunTurnResult> {
    const { text } = message
    if (typeof text !== "string" || text.trim().length === 0) {
      throw new SessionDataError("invalid-input", "message.text 必须是非空字符串")
    }
    const session = await this.ensureResident(sessionId)
    if (session.status !== "active") {
      throw new SessionDataError("invalid-state", "Session 当前不能执行 Turn")
    }
    signal?.throwIfAborted()
    let configSnapshot: TurnConfig | undefined
    try {
      // 在等待上一轮之前取快照，避免排队期间的修改影响已经提交的 Turn。
      configSnapshot = config === undefined ? undefined : structuredClone(config)
    } catch (cause) {
      throw new SessionDataError("invalid-input", "Turn config 必须是可结构化克隆的数据", {
        cause,
      })
    }
    return this.runtimeFor(sessionId).runTurn(
      () => this.execute(sessionId, { text }, signal, configSnapshot, onEvent),
      signal,
    )
  }

  /**
   * 停止接收 Turn，并等待已开始的 Turn 写完后进入 closing。后处理由后台任务执行。
   *
   * @param sessionId 要关闭的 Session。可对 closing Session 再次调用以重试收尾。
   * @returns 已释放玩偶占用的 closing 记录，或已经关闭的 closed 记录。
   */
  async requestClose(sessionId: string): Promise<SessionRecord> {
    let resident = this.data.agent.getSession(sessionId)
    if (resident === undefined) {
      const saved = await this.data.read.getSession(sessionId)
      if (saved?.status === "closed") {
        return saved
      }
      if (saved === undefined) {
        throw new SessionDataError("session-not-found", `Session '${sessionId}' 不存在`)
      }
      // 重启后 active/closing 会话尚未驻留：先从持久化恢复再关闭
      resident = (await this.data.agent.restoreSession(sessionId)).session
    }
    if (resident.status === "closing") {
      this.finalization.dispatch(sessionId)
      return resident
    }

    return this.runtimeFor(sessionId).requestClose(async () => {
      const closing = await this.data.agent.beginClosingSession(sessionId)
      this.runtimes.delete(sessionId)
      this.finalization.dispatch(sessionId)
      return closing
    })
  }

  /**
   * 等待已投递的后台后处理结束。示例、测试或宿主停机时可调用。
   *
   * @returns 所有后台任务本次尝试均已结束。可查询 Session 状态区分成功与待重试。
   */
  waitForPostprocessing(): Promise<void> {
    return this.finalization.waitForIdle()
  }

  /** 返回驻留的 Session；进程重启后自动从持久化恢复 active/closing 会话。 */
  private async ensureResident(sessionId: string): Promise<SessionRecord> {
    const resident = this.data.agent.getSession(sessionId)
    if (resident !== undefined) {
      return resident
    }
    return (await this.data.agent.restoreSession(sessionId)).session
  }

  private runtimeFor(sessionId: string): SessionRuntime {
    let runtime = this.runtimes.get(sessionId)
    if (runtime === undefined) {
      runtime = new SessionRuntime()
      this.runtimes.set(sessionId, runtime)
    }
    return runtime
  }

  /** 在运行队列内创建 Turn，准备 Agent 的输入，并限制事件写入的归属和有效期。 */
  private async execute(
    sessionId: string,
    message: UserMessage,
    signal: AbortSignal | undefined,
    config: TurnConfig | undefined,
    onEvent: ((event: unknown) => void) | undefined,
  ): Promise<RunTurnResult> {
    // 开始执行时固定本轮使用的函数，并在任何写入前确认 Agent 已就绪。
    const executeTurn = this.executorRegistration?.executeTurn
    if (executeTurn === undefined) {
      throw new SessionDataError("invalid-state", "Turn 执行器尚未注册")
    }
    const agent = this.data.agent
    const turn = await agent.createTurn(sessionId)
    await agent.appendEvents(sessionId, turn.turnId, [
      { eventType: "user_message", payload: { text: message.text } },
    ])
    // 创建开始后先写完用户消息，再响应取消，避免留下仅因取消而产生的空 Turn。
    signal?.throwIfAborted()

    const snapshot = agent.getHistory(sessionId)
    const previousTurns = snapshot.turns.filter(
      ({ turn: previous }) => previous.turnNo < turn.turnNo,
    )
    let executing = true
    try {
      const result = await executeTurn({
        session: snapshot.session,
        turn,
        message,
        ...(config === undefined ? {} : { config }),
        signal,
        ...(onEvent === undefined ? {} : { onEvent }),
        turnCount: snapshot.turns.length,
        history: toModelHistory(previousTurns),
        getPreviousTurns: (count) => agent.getPreviousTurnEvents(sessionId, turn.turnId, count),
        appendEvents: async (events) => {
          if (!executing) {
            throw new SessionDataError("invalid-state", "Turn 执行器已退出，不能再追加 Event")
          }
          if (events.some(({ eventType }) => eventType === "user_message")) {
            throw new SessionDataError("invalid-input", "当前用户消息已由 Session 写入")
          }
          return agent.appendEvents(sessionId, turn.turnId, events)
        },
      })
      return { turnId: turn.turnId, result }
    } finally {
      executing = false
    }
  }
}

/** 将按轮次排列的历史投影为 Chat 消息，工具事件等数据仍可通过原始历史接口读取。 */
function toModelHistory(turns: readonly TurnHistory[]): ModelHistoryMessage[] {
  const history: ModelHistoryMessage[] = []
  for (const { events } of turns) {
    for (const { eventType, payload } of events) {
      if (
        (eventType === "user_message" || eventType === "assistant_message") &&
        typeof payload === "object" &&
        "text" in payload &&
        typeof payload.text === "string"
      ) {
        history.push({
          role: eventType === "user_message" ? "user" : "assistant",
          content: payload.text,
        })
      }
    }
  }
  return history
}
