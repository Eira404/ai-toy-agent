import type { LlmSupportModel } from "toy-model-support"
import type { DailyUnitInput } from "toy-memory-daily"
import { IMPORTANCE_SYSTEM_MESSAGE } from "../prompts.js"
import { ImportanceOutputSchema, type ImportanceLevel } from "../schema.js"
import { ValueEngineError } from "../error.js"

/** 初始化时的内部重要性分类器；只返回等级，具体 I/S/P 初值由数值核心计算。 */
export class ImportanceJudge {
  constructor(private readonly model: LlmSupportModel) {}

  /**
   * @param input 已由 ValueEngine.initialize 校验的单元正文；domain 仅作语境。
   * @returns low/normal/high/core；模型的 reason 不参与数值运算。
   * @throws ValueEngineError model-failed：调用失败或输出不符合 Schema。
   */
  async judge(input: DailyUnitInput): Promise<ImportanceLevel> {
    try {
      const result = await this.model.invoke({
        schema: ImportanceOutputSchema,
        systemMessage: IMPORTANCE_SYSTEM_MESSAGE,
        userMessage: JSON.stringify(input),
      })
      return result.importance
    } catch (error) {
      throw new ValueEngineError("model-failed", "重要性模型调用或输出校验失败", { cause: error })
    }
  }
}
