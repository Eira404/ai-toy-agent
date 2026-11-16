import type { LlmSupportModel } from "toy-model-support"
import type { UnitContent } from "toy-memory-daily"
import { CONTENT_CHANGE_SYSTEM_MESSAGE } from "../prompts.js"
import { ContentChangeOutputSchema, type ContentChange } from "../schema.js"
import { ValueEngineError } from "../error.js"

/** 旧新正文的内部语义分类器；不改变价值，分类由 ValueEngine 映射为强化策略。 */
export class ContentChangeJudge {
  constructor(private readonly model: LlmSupportModel) {}

  /**
   * @param oldContent 已校验的旧正文。
   * @param newContent 同一单元的新正文；两者类型一致性由 ValueEngine 保证。
   * @returns 正文未变直接 unchanged；其他情况由模型区分改写、补充、状态变化或纠错。
   * @throws ValueEngineError model-failed。
   */
  async judge(oldContent: UnitContent, newContent: UnitContent): Promise<ContentChange> {
    // 仅改标题、摘要或正文边界空白不触发强化；不折叠 Markdown 内部空白。
    if (normalizeBody(oldContent.body) === normalizeBody(newContent.body)) {
      return "unchanged"
    }
    try {
      const result = await this.model.invoke({
        schema: ContentChangeOutputSchema,
        systemMessage: CONTENT_CHANGE_SYSTEM_MESSAGE,
        userMessage: JSON.stringify({ oldContent, newContent }),
      })
      return result.changeType
    } catch (error) {
      throw new ValueEngineError("model-failed", "正文变化模型调用或输出校验失败", { cause: error })
    }
  }
}

/** 只统一 CRLF 和边界空白；保留 Markdown 内部缩进、换行等可能携带语义的字符。 */
function normalizeBody(body: string): string {
  return body.replace(/\r\n/g, "\n").trim()
}
