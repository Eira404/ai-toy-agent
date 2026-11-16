import type { Context } from "cordis"
import type {
  PromptSection,
  SystemPromptAssembler,
  TurnPreprocessingNodeContext,
} from "toy-agent-loop"
import { JevSupport, type JevSupportConfig } from "toy-model-support"
import type { SessionPreprocessingContext } from "toy-session"
import type { FastExtractResult } from "toy-memory-write"
import "toy-memory-space"
import "toy-memory-write"
import {
  buildGateState,
  MEMORY_INTENT_SCHEMA,
  type MemoryGateInput,
  type MemoryGateResult,
} from "./gate.js"

declare module "cordis" {
  interface Context {
    memoryOnline: MemoryOnline
  }
}

/** Session 预处理节点名：解析并保存 memorySpaceId。 */
export const MEMORY_SPACE_NODE = "memory-space"
/** Turn 预处理节点名：JEV 门控 + 分情况提取；工具包据此判断是否注入 memory_write。 */
export const MEMORY_GATE_NODE = "memory-gate"

/** `memory-gate` 节点的返回结构（进入 preprocessing.data，供工具与提示片段读取）。 */
export interface GateNodeResult {
  readonly explicit: boolean
  /** 本会话是否绑定了 active 记忆空间；false 时记忆功能整体关闭。 */
  readonly available: boolean
  readonly extract: FastExtractResult["kind"] | "no-space" | null
  readonly count: number
}

/**
 * 在线记忆编排服务。
 *
 * 职责：
 * - Session 预处理 `memory-space`：调用 `toy-memory-space` 解析当前娃娃的 active
 *   空间并写入 Session payload，后续 Turn 沿用该绑定；
 * - Turn 预处理 `memory-gate`：用 JEV 判断用户是否「明确要求记住」。explicit 时不
 *   自动提取（交给 memory_write 工具）；implicit 时自行提取并保证落库（wait:"written"），
 *   以便把提取结果注入提示、避免主模型虚假承诺。
 *
 * 依赖：`toy-session`、`toy-agent-loop`、`toy-memory-space`、`toy-memory-write`，
 * 以及 `toy-jev`（JEV runtime，宿主需注册 Adapter）。
 */
export class MemoryOnline extends JevSupport<MemoryGateInput, MemoryGateResult> {
  static override inject = ["session", "agentLoop", "memorySpace", "memoryWrite", ...super.inject]

  constructor(ctx: Context, config: JevSupportConfig = {}) {
    super(ctx, "memoryOnline", config)

    // 1) Session 预处理：解析当前娃娃的 active 空间，写入 payload.preprocessing。
    ctx.effect(
      () =>
        ctx.session.preprocessing.register({
          name: MEMORY_SPACE_NODE,
          process: ({ userId, deviceId }: SessionPreprocessingContext) =>
            ctx.memorySpace.resolveMemorySpace(userId, deviceId).then((memorySpaceId) => ({
              memorySpaceId,
            })),
        }),
      "memoryOnline.registerSpace",
    )

    // 2) Turn 预处理：JEV 门控 + 分情况提取。
    ctx.effect(
      () =>
        ctx.agentLoop.preprocessing.register({
          name: MEMORY_GATE_NODE,
          order: 100,
          process: async ({
            session,
            turn,
            message,
            history,
            signal,
          }: TurnPreprocessingNodeContext): Promise<GateNodeResult> => {
            const scope = scopeFor(session)
            if (scope === null) {
              return { explicit: false, available: false, extract: "no-space", count: 0 }
            }
            const gate = await this.analyze({ message, history: [...history] }, signal)
            if (gate.memoryIntent === "explicit") {
              return { explicit: true, available: true, extract: null, count: 0 }
            }
            const result = await ctx.memoryWrite.extract(
              {
                scope,
                sessionId: session.sessionId,
                turnId: turn.turnId,
                userMessage: message,
                recentConversation: history,
                ...(signal === undefined ? {} : { signal }),
              },
              "written",
            )
            return {
              explicit: false,
              available: true,
              extract: result.kind,
              count: result.kind === "written" ? result.records.length : 0,
            }
          },
        }),
      "memoryOnline.registerGate",
    )

    // 3) 可选：宿主加载 SystemPromptAssembler 时，注入提取结果提示片段。
    const systemPrompt = ctx.reflect.get("systemPrompt") as SystemPromptAssembler | undefined
    if (systemPrompt !== undefined) {
      ctx.effect(
        () => systemPrompt.registerSection(memoryExtractSection()),
        "memoryOnline.registerSection",
      )
    }
  }

  /** JEV 二分类：用户是否明确要求记住。 */
  override analyze(input: MemoryGateInput, signal?: AbortSignal): Promise<MemoryGateResult> {
    return this.invokeJevChoice({
      state: buildGateState(input),
      name: "memoryIntent",
      instructions:
        "判断用户当前消息是否明确表达了要记住某件事（如「记住…」「别忘了…」「帮我记一下…」）。普通陈述、提问或其他都算 implicit。",
      criteria: {
        explicit: "用户明确要求记住或保存某条信息",
        implicit: "用户只是普通陈述、提问或其他，没有明确要求记住",
      },
      schema: MEMORY_INTENT_SCHEMA,
      ...(signal === undefined ? {} : { signal }),
    })
  }
}

export default MemoryOnline

// ---------------------------------------------------------------------------
// 模块级辅助
// ---------------------------------------------------------------------------

/** 记忆范围隔离；结构等价于 `toy-memory-fast` 的 `Scope`。 */
export interface MemoryScope {
  readonly userId: string
  readonly memorySpaceId: string
}

/** 从 Session 记录的 payload.preprocessing["memory-space"] 解析出记忆 scope。 */
export function scopeFor(session: { readonly userId: string; readonly payload: unknown }): MemoryScope | null {
  const memorySpaceId = readMemorySpaceId(session.payload)
  if (memorySpaceId === null) {
    return null
  }
  return { userId: session.userId, memorySpaceId }
}

/** 只读解析 Session payload 里保存的 memorySpaceId；缺失或非法返回 null。 */
export function readMemorySpaceId(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) {
    return null
  }
  if (!("preprocessing" in payload)) {
    return null
  }
  const preprocessing = (payload as { preprocessing: unknown }).preprocessing
  if (typeof preprocessing !== "object" || preprocessing === null) {
    return null
  }
  const node = (preprocessing as Record<string, unknown>)[MEMORY_SPACE_NODE]
  if (typeof node !== "object" || node === null) {
    return null
  }
  const memorySpaceId = (node as { memorySpaceId?: unknown }).memorySpaceId
  return typeof memorySpaceId === "string" && memorySpaceId.trim().length > 0 ? memorySpaceId : null
}

/** 生成提取结果提示片段：明确区分「已提取」「未提取」，防止模型虚假承诺。 */
export function memoryExtractSection(): PromptSection {
  return {
    name: "memory-extract-status",
    order: 10,
    render: (context) => {
      const gate = gateResultOf(context.preprocessing.data[MEMORY_GATE_NODE])
      if (gate === null) {
        return ""
      }
      if (!gate.available) {
        return "当前玩偶未绑定记忆空间，记忆功能未开启。不要声称记住了，也不要调用记忆工具；若用户要求记住，可说明记忆功能未开启。"
      }
      if (gate.explicit) {
        return "用户已明确要求记住内容。请调用 memory_write 工具写入记忆，写入后向用户确认已记住。"
      }
      if (gate.extract === "written" && gate.count > 0) {
        return `已根据用户本轮内容自动提取并落库 ${gate.count} 条记忆。是否告知用户由你决定；若告知，可自然表达已记住，但不要逐条复述记忆内部格式。`
      }
      return "本轮未从用户内容中提取到需要落库的记忆。不要声称「我已经记住了」；是否向用户说明由你决定，通常无需主动提及。"
    },
  }
}

function gateResultOf(value: unknown): GateNodeResult | null {
  if (typeof value !== "object" || value === null) {
    return null
  }
  const candidate = value as Partial<GateNodeResult>
  return typeof candidate.explicit === "boolean" ? (candidate as GateNodeResult) : null
}
