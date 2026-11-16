/**
 * adapter 共享辅助（纯函数，无副作用）。
 */
import type { ConversationItem, Session, TurnExtraction } from "./types.ts"

/** 把一串会话展开成逐 user-turn 的 extract 输入（升序，recentConversation 为当轮之前已见轮）。 */
export function buildTurnsFromHistory(history: readonly Session[]): TurnExtraction[] {
  const units: TurnExtraction[] = []
  for (const session of history) {
    const conversation: ConversationItem[] = []
    session.turns.forEach((turn, j) => {
      if (turn.role === "user") {
        units.push({
          sessionId: session.sessionId,
          turnId: `${session.sessionId}-t${j}`,
          userMessage: turn.content,
          recentConversation: [...conversation],
        })
      }
      conversation.push({ role: turn.role, content: turn.content })
    })
  }
  return units
}
