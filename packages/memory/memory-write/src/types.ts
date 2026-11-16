import type { FastDraft, FastRecord, Scope } from "toy-memory-fast"

export type { Scope }

/**
 * `toy-memory-write` 的公共类型契约。
 *
 * `Scope`、`FastDraft`、`FastRecord` 复用 `toy-memory-fast` 导出的契约，
 * 本包只定义「提取/写入」的输入、等待级别与终态结果。
 */

/** 一段对话（调用方从 Session 历史转换），按时间升序。 */
export interface ConversationItem {
  readonly role: "user" | "assistant"
  readonly content: string
}

/** `extract` 的输入：当前用户原话 + 近期有序对话（用于消歧指代）。 */
export interface FastExtractInput {
  readonly scope: Scope
  readonly sessionId: string
  readonly turnId: string
  /** 当前用户原话，本轮新增事实的主要来源。 */
  readonly userMessage: string
  readonly recentConversation: readonly ConversationItem[]
  readonly signal?: AbortSignal
}

/** `write` 的输入：直接提供已校验的 title/summary/body。 */
export interface FastWriteInput {
  readonly scope: Scope
  readonly sessionId: string
  readonly turnId: string
  readonly drafts: readonly FastDraft[]
  readonly signal?: AbortSignal
}

/**
 * 提取等待级别：
 * - `started`：启动 LLM 提取后立即返回（后台继续落库）；
 * - `written`：等待提取、校验并落库完成后返回。
 */
export type ExtractWait = "started" | "written"

/**
 * `extract` 的终态结果。
 * - `started`：已启动提取，结果未定（仅 `wait="started"` 返回）；
 * - `written`：提取出非空草稿并落库；
 * - `empty`：没有新增事实，未写入；
 * - `failed`：重试耗尽，未写入。
 */
export type FastExtractResult =
  | { readonly kind: "started" }
  | {
      readonly kind: "written"
      readonly writeId: string
      readonly records: readonly FastRecord[]
      readonly attempts: number
    }
  | { readonly kind: "empty"; readonly attempts: number }
  | { readonly kind: "failed"; readonly attempts: number; readonly error: string }

/** `write` 的结果：直接落库成功。 */
export type FastWriteResult = {
  readonly kind: "written"
  readonly writeId: string
  readonly records: readonly FastRecord[]
}
