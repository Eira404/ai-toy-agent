import { z } from "zod"
import {
  DEFAULT_MODE_CATALOG,
  ENGLISH_PRACTICE_CATALOG,
  type DefaultMode,
  type EnglishPracticeMode,
  type ModeState,
} from "./mode-catalog.js"

const ENGLISH_PRACTICE_IDS = ENGLISH_PRACTICE_CATALOG.map((mode) => mode.id) as [
  EnglishPracticeMode,
  ...EnglishPracticeMode[],
]
const DEFAULT_MODE_IDS = DEFAULT_MODE_CATALOG.map((mode) => mode.id) as [
  DefaultMode,
  ...DefaultMode[],
]

/** 跨轮传递或持久化的模式状态快照。 */
export const ModeStateSchema = z.object({
  defaultMode: z.enum(DEFAULT_MODE_IDS),
  englishPractice: z.enum(ENGLISH_PRACTICE_IDS),
})

/** 模式判断的输入：当前 Query、上一轮文本对话与上一轮模式。 */
export const ModeAnalysisInputSchema = z.object({
  query: z.string().trim().min(1, "Query 不能为空"),
  history: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string().trim().min(1),
      }),
    )
    .default([]),
  previous: ModeStateSchema,
})

/** 模式判断的最终结果，即新一轮的模式状态。 */
export const ModeAnalysisResultSchema = ModeStateSchema

export type ModeAnalysisInput = z.input<typeof ModeAnalysisInputSchema>
export type ParsedModeAnalysisInput = z.output<typeof ModeAnalysisInputSchema>
export type ModeAnalysisResult = z.infer<typeof ModeAnalysisResultSchema>

/** 单个信号判定的阈值：达到即视为触发。 */
export const SIGNAL_THRESHOLD = 0.5

/** JEV 返回的四个软信号；状态机在代码里据此决定下一步。 */
export interface ModeSignals {
  readonly english: number
  readonly startContinue: number
  readonly stop: number
  readonly relevantChinese: number
}

/** 由英语对练状态推导默认模式：退出英语对练即回到默认模式。 */
export function deriveModeState(englishPractice: EnglishPracticeMode): ModeState {
  return {
    englishPractice,
    defaultMode: englishPractice === "no" ? "yes" : "no",
  }
}

/**
 * 根据当前英语对练状态和 JEV 信号，确定下一步英语对练状态。
 *
 * 转移规则（按优先级）：
 * - 明确表示结束 → 否；
 * - 说英文或表示想开始/继续 → 是；
 * - 未进入英语对练（否）且无上述触发 → 保持否；
 * - 已进入（是/待退出）且用中文提出与英语学习相关的问题 → 是；
 * - 已进入且用中文说了无关内容 → 待退出。
 */
export function nextEnglishPracticeMode(
  previous: EnglishPracticeMode,
  signals: ModeSignals,
): EnglishPracticeMode {
  if (signals.stop >= SIGNAL_THRESHOLD) {
    return "no"
  }
  if (signals.english >= SIGNAL_THRESHOLD || signals.startContinue >= SIGNAL_THRESHOLD) {
    return "yes"
  }
  if (previous === "no") {
    return "no"
  }
  if (signals.relevantChinese >= SIGNAL_THRESHOLD) {
    return "yes"
  }
  return "pending-exit"
}

/** 拼装 JEV 的 state 文本：当前模式 + 历史 + 当前用户输入。 */
export function createJevState(input: ParsedModeAnalysisInput): string {
  const history = input.history.map(
    (message) => `${message.role === "user" ? "上一轮用户" : "上一轮助手"}：${message.content}`,
  )
  const currentMode = `当前模式：英语对练=${englishPracticeName(input.previous.englishPractice)}，默认=${input.previous.defaultMode === "yes" ? "是" : "否"}`
  return [
    `<CURRENT_MODE>\n${currentMode}\n</CURRENT_MODE>`,
    `<HISTORY>\n${history.join("\n")}\n</HISTORY>`,
    `<QUERY>\n${input.query}\n</QUERY>`,
  ].join("\n")
}

function englishPracticeName(mode: EnglishPracticeMode): string {
  return ENGLISH_PRACTICE_CATALOG.find((item) => item.id === mode)?.name ?? mode
}
