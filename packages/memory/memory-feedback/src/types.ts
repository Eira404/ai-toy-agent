import type { JsonValue } from "toy-storage-relational"
import type { LongBlockHit, LongDetailHit } from "toy-memory-long"

// ============ 基础类型 ============

/** 价值单元类型：一个 Long 块的「当下概括」或其中一条「细节补充」。 */
export type ValueUnitType = "overview" | "detail"

/** Session 收尾时价值系统对单个价值单元给出的态度判断。 */
export type FeedbackType =
  | "no_user_signal"
  | "confirmed"
  | "supplemented"
  | "follow_up"
  | "corrected"
  | "irrelevant"
  | "uncertain"

/** 以用户 + 记忆空间标识的隔离范围。 */
export interface FeedbackScope {
  readonly userId: string
  readonly memorySpaceId: string
}

// ============ 输入契约（由提取插件从 Session event 提取后传入）============

/** 直接复用 Long 检索结果的正文字段，不改名、不从数据库重新读取。 */
export type OverviewRecallContent = Pick<LongBlockHit, "title" | "summary" | "overviewBody">
export type DetailRecallContent = Pick<LongDetailHit, "summary" | "body">

/** 一轮检索实际提供给 Agent 的一个价值单元，包含当时的正文快照。 */
export type RecallUnit = {
  /** 稳定单元标识：overview 时是 blockId，detail 时是 detailId。 */
  readonly unitId: string
  /** 所属 Long 块 ID（detail 单元时为父块，overview 单元时等于 unitId）。 */
  readonly blockId: string
} & (
  | { readonly unitType: "overview"; readonly recalledContent: OverviewRecallContent }
  | { readonly unitType: "detail"; readonly recalledContent: DetailRecallContent }
)

/** 单个单元的一次召回；同 Session 多次召回时保留每次的内容与所属轮次。 */
export type RecallSnapshot = RecallUnit & {
  readonly turnNo: number
  readonly turnId: string
}

/** 某个 Turn 内检索到的全部价值单元。 */
export interface RecallEntry {
  /** 检索发生在哪一轮，用于确定召回影响区间顺序。 */
  readonly turnNo: number
  /** 产生检索的 Turn ID。 */
  readonly turnId: string
  /** 该轮实际提供的价值单元；可为空数组。 */
  readonly units: readonly RecallUnit[]
}

/** 一轮对话：用户表达是判断态度的唯一依据，助手回答仅作语境参考。 */
export interface ConversationTurn {
  readonly turnNo: number
  /** 该轮用户原文。 */
  readonly userText: string
  /** 该轮助手回答。 */
  readonly assistantText: string
}

/** settleSessionFeedback 的完整输入。 */
export interface SettleSessionFeedbackInput {
  readonly userId: string
  readonly memorySpaceId: string
  readonly sessionId: string
  /** 从 memory_read 的 tool_result.data.units 提取，保留召回时的正文快照。 */
  readonly recalls: readonly RecallEntry[]
  /** 从 user_message / assistant_message event 提取：完整有序对话。 */
  readonly conversation: readonly ConversationTurn[]
  readonly signal?: AbortSignal
}

// ============ 价值系统接口 ============

/** judgeSession 的输入：单个价值单元的召回正文快照、助手语境与后续用户证据。 */
export type JudgeSessionInput = RecallUnit & {
  /** recalledContent 是首次召回的快照；各次快照均保存在此，按 Turn 升序。 */
  readonly recallSnapshots: readonly RecallSnapshot[]
  /** 该单元本 Session 的全部召回 Turn 号，升序。 */
  readonly recallTurnNos: readonly number[]
  /** 召回当轮的助手回答，仅作语境；用户态度证据仍来自 relevantTurns。 */
  readonly recallAssistantTurns: readonly Pick<ConversationTurn, "turnNo" | "assistantText">[]
  /** 第一次召回之后、落在影响区间内的对话轮次，升序。 */
  readonly relevantTurns: readonly ConversationTurn[]
  /** 调用方取消信号，透传给价值系统内的模型调用。 */
  readonly signal?: AbortSignal
}

/** 价值系统在 Session 收尾时对单个价值单元的判断结果。 */
export interface FeedbackJudgement {
  /** 用户对该记忆的态度。 */
  readonly feedbackType: FeedbackType
  /** 支持该态度的用户证据 Turn 号；no_user_signal 时为空。 */
  readonly evidenceTurnNos: readonly number[]
  /** 价值系统的临时判断数据，引擎私有，程序不解析。 */
  readonly judgementData: JsonValue
  /** judgementData 的格式版本，用于引擎升级迁移。 */
  readonly judgementVersion: number
}

/**
 * 价值系统在 feedback 侧声明的接口：只负责 Session 收尾时的态度判断。
 *
 * 价值系统被拆成两个接口：本包声明 `FeedbackValueEngine`（态度判断），
 * `toy-memory-daily` 声明 `DailyValueEngine`（价值数值计算）。引擎一个类
 * 实现两个接口，初始化时分别注册到两边。
 */
export interface FeedbackValueEngine {
  /** Session 收尾：判断一个价值单元的态度 + 临时数据。 */
  judgeSession(input: JudgeSessionInput): Promise<FeedbackJudgement>
}

// ============ 反馈产物（落库记录）============

/** 落库后的 Session 反馈记录：价值系统产物 + 身份与审计字段。 */
export interface FeedbackOutcome extends FeedbackJudgement {
  readonly feedbackId: string
  readonly userId: string
  readonly memorySpaceId: string
  readonly sessionId: string
  readonly unitType: ValueUnitType
  readonly unitId: string
  readonly blockId: string
  /** 本 Session 该单元的全部召回 Turn 号（审计冗余）。 */
  readonly recallTurnNos: readonly number[]
  /** 被哪个 Daily 批次巩固；成功提交后写入。 */
  readonly consumedBatchId: string | null
  /** 巩固时间。 */
  readonly consumedAt: string | null
  readonly createdAt: string
  readonly updatedAt: string
}

/** 插件初始化配置。 */
export interface MemoryFeedbackConfig {
  /** 已连接的关系型存储实例名称；默认 main。 */
  readonly sourceName?: string
}
