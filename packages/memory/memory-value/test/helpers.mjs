import { ValueEngine, ForgettingEngine, encodeValueState } from "../lib/index.js"

export const config = { llmProvider: "fake", llmModel: "fake-model" }

export function makeEngine(
  respond = () => ({ importance: "normal", reason: "普通偏好。" }),
  options = {},
) {
  const calls = []
  const llm = {
    async generate(request) {
      calls.push(request)
      const output = await respond(request)
      return output?.finish
        ? output
        : {
            content: [
              { type: "text", text: typeof output === "string" ? output : JSON.stringify(output) },
            ],
            finish: { kind: "stop" },
          }
    },
  }
  return { engine: new ValueEngine(llm, { ...config, ...options }), calls }
}

export function initial(level = "normal", overrides) {
  const numeric = new ForgettingEngine(overrides)
  return encodeValueState(numeric.initialize(level))
}

export function feedbackOutput(type = "confirmed", evidenceTurnNos = [2]) {
  return {
    primaryFeedbackType: type,
    reason: "用户态度依据。",
    signals:
      type === "no_user_signal"
        ? []
        : [{ feedbackType: type, evidenceTurnNos, reason: "用户原文支持。" }],
  }
}

export function judgeInput(overrides = {}) {
  const unit = {
    unitType: "overview",
    unitId: "b1",
    blockId: "b1",
    recalledContent: { title: "咖啡", summary: "喜欢冰美式", overviewBody: "用户喜欢冰美式。" },
  }
  return {
    ...unit,
    recallTurnNos: [1],
    recallSnapshots: [{ ...unit, turnNo: 1, turnId: "t1" }],
    recallAssistantTurns: [{ turnNo: 1, assistantText: "你喜欢冰美式。" }],
    relevantTurns: [{ turnNo: 2, userText: "对。", assistantText: "好的。" }],
    ...overrides,
  }
}

export function contents(type = "overview") {
  const oldContent = {
    unitType: type,
    summary: "喜欢冰美式",
    body: "用户喜欢冰美式。",
    ...(type === "overview" ? { title: "咖啡" } : {}),
  }
  return { oldContent, newContent: { ...oldContent, body: "用户喜欢冰美式，也喜欢浅烘豆。" } }
}
