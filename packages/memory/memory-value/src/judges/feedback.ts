import type { LlmSupportModel } from "toy-model-support"
import type { FeedbackJudgement, JudgeSessionInput } from "toy-memory-feedback"
import {
  FeedbackOutputSchema,
  JudgeSessionInputSchema,
  JudgementDataSchema,
  type FeedbackOutput,
  type JudgementData,
} from "../schema.js"
import { FEEDBACK_SYSTEM_MESSAGE } from "../prompts.js"
import { ValueEngineError } from "../error.js"

/** 本引擎反馈私有 JSON 的版本；不等同于数值状态的 VALUE_VERSION。 */
export const JUDGEMENT_VERSION = 1

/** 归并规则同时供模型结果和落库反馈校验使用；纠错优先由程序保证。 */
function aggregate(output: FeedbackOutput): FeedbackJudgement {
  if (output.signals.length === 0) {
    if (output.primaryFeedbackType !== "no_user_signal") {
      throw new ValueEngineError("invalid-judgement", "有用户态度时必须提供证据")
    }
  } else if (output.primaryFeedbackType === "no_user_signal") {
    throw new ValueEngineError("invalid-judgement", "no_user_signal 不能携带用户信号")
  }
  // 纠错优先在程序里执行，避免模型给出的正向主态度掩盖它已识别出的纠错证据。
  const corrected = output.signals.filter((signal) => signal.feedbackType === "corrected")
  const feedbackType = corrected.length > 0 ? "corrected" : output.primaryFeedbackType
  // 顶层 evidenceTurnNos 仅取最终态度的证据；私有 signals 仍保存其他态度，便于审计。
  const selected = output.signals.filter((signal) => signal.feedbackType === feedbackType)
  if (feedbackType !== "no_user_signal" && selected.length === 0) {
    throw new ValueEngineError("invalid-judgement", "主要态度必须有对应证据")
  }
  const reason = corrected.length > 0 ? corrected[0]!.reason : output.reason
  const judgementData: JudgementData = { reason, signals: output.signals }
  return {
    feedbackType,
    evidenceTurnNos: [...new Set(selected.flatMap((signal) => signal.evidenceTurnNos))].sort(
      (a, b) => a - b,
    ),
    judgementData,
    judgementVersion: JUDGEMENT_VERSION,
  }
}

/**
 * settle 前复核持久化反馈的版本、私有结构及最终态度/证据是否一致。
 *
 * @param input 本引擎产生的 FeedbackJudgement，允许传入带落库字段的 FeedbackOutcome。
 * @returns 重新归并后的判断副本，不依赖额外的 Session/存储字段。
 * @throws ValueEngineError unsupported-judgement-version 或 invalid-judgement。
 * 此处没有对话输入，只能验证结构一致性；原始证据的轮次归属已在 judge 中验证。
 */
export function validateJudgement(input: FeedbackJudgement): FeedbackJudgement {
  if (input.judgementVersion !== JUDGEMENT_VERSION) {
    throw new ValueEngineError(
      "unsupported-judgement-version",
      `不支持反馈版本 '${input.judgementVersion}'`,
    )
  }
  const data = JudgementDataSchema.safeParse(input.judgementData)
  if (!data.success) {
    throw new ValueEngineError("invalid-judgement", "反馈判断数据格式无效", { cause: data.error })
  }
  const output = FeedbackOutputSchema.safeParse({
    primaryFeedbackType: input.feedbackType,
    ...data.data,
  })
  if (!output.success) {
    throw new ValueEngineError("invalid-judgement", "反馈态度无效", { cause: output.error })
  }
  const expected = aggregate(output.data)
  if (
    expected.feedbackType !== input.feedbackType ||
    JSON.stringify(expected.evidenceTurnNos) !== JSON.stringify(input.evidenceTurnNos)
  ) {
    throw new ValueEngineError("invalid-judgement", "反馈态度或证据与判断数据不一致")
  }
  return expected
}

/** 引擎内部的态度判断器；公开使用入口是 ValueEngine.judgeSession。 */
export class FeedbackJudge {
  constructor(private readonly model: LlmSupportModel) {}

  /** 校验快照及影响区间，调用模型，再核对用户证据；所有失败均明确传播。 */
  async judge(input: JudgeSessionInput): Promise<FeedbackJudgement> {
    input.signal?.throwIfAborted()
    const parsed = JudgeSessionInputSchema.safeParse(input)
    if (!parsed.success) {
      throw new ValueEngineError("invalid-input", "反馈输入格式无效", { cause: parsed.error })
    }
    const data = parsed.data
    const firstRecall = data.recallTurnNos[0]!
    if (
      !ascendingUnique(data.recallTurnNos) ||
      !ascendingUnique(data.relevantTurns.map((turn) => turn.turnNo)) ||
      data.relevantTurns.some((turn) => turn.turnNo <= firstRecall)
    ) {
      throw new ValueEngineError(
        "invalid-input",
        "召回轮次必须有序去重，反馈轮次必须在首次召回之后",
      )
    }
    // 每个召回轮都必须有快照；同一单元允许多个版本，但不能串入其他单元/父块。
    const recallNos = new Set(data.recallTurnNos)
    const snapshotNos = new Set(data.recallSnapshots.map((snapshot) => snapshot.turnNo))
    if (
      data.recallSnapshots.some(
        (snapshot, index) =>
          snapshot.unitType !== data.unitType ||
          snapshot.unitId !== data.unitId ||
          snapshot.blockId !== data.blockId ||
          !recallNos.has(snapshot.turnNo) ||
          (snapshot.unitType === "overview" && snapshot.unitId !== snapshot.blockId) ||
          (index > 0 && snapshot.turnNo < data.recallSnapshots[index - 1]!.turnNo),
      ) ||
      data.recallTurnNos.some((no) => !snapshotNos.has(no)) ||
      (data.unitType === "overview" && data.unitId !== data.blockId) ||
      JSON.stringify(data.recalledContent) !==
        JSON.stringify(data.recallSnapshots[0]!.recalledContent) ||
      data.recallAssistantTurns.some((turn) => !recallNos.has(turn.turnNo))
    ) {
      throw new ValueEngineError("invalid-input", "召回快照必须与单元、首次正文和召回轮次一致")
    }
    // 助手回答只能帮助理解「对/不对」的指向，不能成为态度证据本身。
    const allowedTurns = new Set(
      data.relevantTurns
        .filter((turn) => turn.userText.trim().length > 0)
        .map((turn) => turn.turnNo),
    )
    // 没有后续用户原文时可确定为无信号，无需让模型猜测或产生调用成本。
    if (allowedTurns.size === 0) {
      return aggregate({
        primaryFeedbackType: "no_user_signal",
        signals: [],
        reason: "首次召回后没有用户表达。",
      })
    }
    let output: FeedbackOutput
    try {
      output = await this.model.invoke({
        schema: FeedbackOutputSchema,
        systemMessage: FEEDBACK_SYSTEM_MESSAGE,
        userMessage: JSON.stringify(data),
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      })
    } catch (error) {
      // 优先保留取消原因，避免把用户取消包装成普通 model-failed。
      input.signal?.throwIfAborted()
      throw new ValueEngineError("model-failed", "用户态度模型调用或输出校验失败", { cause: error })
    }
    input.signal?.throwIfAborted()
    // Schema 只能检查「轮次是整数」，语境中的证据集合需由程序作第二次校验。
    if (
      output.signals.some((signal) => signal.evidenceTurnNos.some((no) => !allowedTurns.has(no)))
    ) {
      throw new ValueEngineError("invalid-judgement", "证据必须引用影响区间内具有用户原文的轮次")
    }
    return aggregate(output)
  }
}

/** 轮次必须严格递增，不能通过重排输入掩盖影响区间的归属错误。 */
function ascendingUnique(values: readonly number[]): boolean {
  return values.every((value, index) => index === 0 || value > values[index - 1]!)
}
