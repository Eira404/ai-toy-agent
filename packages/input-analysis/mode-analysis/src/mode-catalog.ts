/**
 * 模式目录。
 *
 * 该数据属于 `toy-mode-analysis` 包，由 Prompt 与结果 Schema 共同使用；新增或修改模式时
 * 只维护此文件，禁止在 Agent 或 preprocessing 包中复制一份。
 */

/** 英语对练模式的三态：是 / 待退出 / 否。 */
export const ENGLISH_PRACTICE_CATALOG = [
  {
    id: "yes",
    name: "是",
    description:
      "进入或保持英语对练：用户用交流形式的英文表达，或明确表示想开始/继续英语对练；已处于英语对练时，用户用中文提出与英语学习相关的问题也保持是。",
  },
  {
    id: "pending-exit",
    name: "待退出",
    description:
      "用户已处于英语对练，但本轮用中文说了与英语学习无关的问题或闲聊，进入待退出。",
  },
  {
    id: "no",
    name: "否",
    description: "未进入英语对练，或用户明确表示不再继续英语对练，回到默认模式。",
  },
] as const

export type EnglishPracticeMode = (typeof ENGLISH_PRACTICE_CATALOG)[number]["id"]

/** 默认模式。 */
export const DEFAULT_MODE_CATALOG = [
  { id: "yes", name: "是（默认）", description: "当前处于默认模式。" },
  { id: "no", name: "否（非默认）", description: "当前处于非默认模式（例如英语对练）。" },
] as const

export type DefaultMode = (typeof DEFAULT_MODE_CATALOG)[number]["id"]

/** 一次判断后的完整模式状态。默认模式与英语对练模式保持同步。 */
export interface ModeState {
  defaultMode: DefaultMode
  englishPractice: EnglishPracticeMode
}

/** 会话创建时的初始模式：处于默认模式，未进入英语对练。 */
export const INITIAL_MODE_STATE: ModeState = {
  defaultMode: "yes",
  englishPractice: "no",
}
