import { z } from "zod"
import type { ModelHistoryMessage } from "toy-session"

/**
 * JEV 门控：判断用户当前消息是否「明确要求记住」。
 *
 * `explicit` 时本轮不自动提取、注入 memory_write 工具；`implicit` 时预处理
 * 自行提取记忆。
 */

/** JEV choice 答案的领域 Schema。 */
export const MEMORY_INTENT_SCHEMA = z.object({
  memoryIntent: z.enum(["explicit", "implicit"]),
  confidence: z.number(),
})

/** JEV 门控结果：`explicit` 表示用户明确要求记住。 */
export type MemoryGateResult = z.infer<typeof MEMORY_INTENT_SCHEMA>

/** JEV 门控输入：当前用户原话 + 前几轮文本对话。 */
export interface MemoryGateInput {
  readonly message: string
  readonly history: readonly ModelHistoryMessage[]
}

/** 把当前消息与前几轮对话拼成 JEV 评估用的纯文本 state。 */
export function buildGateState(input: MemoryGateInput): string {
  const lines = input.history.map(
    (message) => `${message.role === "user" ? "上一轮用户" : "上一轮助手"}：${message.content}`,
  )
  return [...lines, `当前用户：${input.message}`].join("\n")
}
