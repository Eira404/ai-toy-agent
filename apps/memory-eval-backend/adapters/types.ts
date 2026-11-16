/**
 * `memory-eval-backend` 的 adapter 公共契约（对齐 REQUIREMENTS.md §4）。
 *
 * 只包含可擦除语法（interface / type），供 Node 24 原生 type-stripping 直接加载。
 * 跨文件只通过 `import type` 引用，运行时无任何导出值。
 */

/** 一段对话轮次。 */
export interface ConversationItem {
  readonly role: "user" | "assistant"
  readonly content: string
}

/** 一个会话：`sessionId` 保持身份，`turns` 按时间升序。 */
export interface Session {
  readonly sessionId: string
  readonly turns: readonly ConversationItem[]
}

/** 一道评测题。 */
export interface Question {
  readonly questionId: string
  /** 能力/题型标签，用于分能力得分。 */
  readonly type: string
  readonly text: string
  /** 标准答案；「无法确定 / not present」表示拒答题。 */
  readonly gold: string
  readonly evidenceIds?: readonly string[]
}

/** shared 模式：单个空间，一份历史。 */
export interface SharedItem {
  readonly spaceKey: string
  readonly history: readonly Session[]
}

/** independent 模式：每题一个空间。 */
export interface IndependentItem {
  readonly spaceKey: string
  readonly questionId: string
  readonly history: readonly Session[]
}

/** 归一化结果：mode 决定 items 的形态。 */
export interface Normalized {
  readonly mode: "shared" | "independent"
  readonly items: readonly (SharedItem | IndependentItem)[]
  readonly questions: readonly Question[]
}

/**
 * extract 的一个单元。在 REQUIREMENTS §4 的 `{ userMessage, recentConversation }`
 * 基础上补充 `sessionId` / `turnId`：`FastWrite.extract` 与 §6 断点恢复都依赖
 * `(spaceKey, sessionId, turnId)` 定位单位。
 */
export interface TurnExtraction {
  readonly sessionId: string
  readonly turnId: string
  readonly userMessage: string
  readonly recentConversation: readonly ConversationItem[]
}

/** 判分 prompt（含 abstention rubric，由 adapter 依据数据集规则生成）。 */
export interface JudgePrompt {
  readonly system: string
  readonly user: string
}

/** 数据集 adapter 契约。 */
export interface BenchmarkAdapter {
  readonly id: string
  readonly mode: "shared" | "independent"
  /** 读取原始数据（构造参数决定数据文件与 start/limit 切片）。 */
  load(): Promise<void>
  /** 归一化成统一中间结构。 */
  normalize(): Normalized
  /** 把某个 item 的历史展开成逐 turn 的 extract 输入序列（升序）。 */
  buildTurns(item: SharedItem | IndependentItem): readonly TurnExtraction[]
  /** 生成判分 prompt（含 abstention 规则）。 */
  judge(question: Question, predicted: string, gold: string): JudgePrompt
  /** 分能力/分组标签（如 5 能力）。 */
  metricGroups(): readonly string[]
}
