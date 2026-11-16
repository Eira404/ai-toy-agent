import type { JevQuestion, JevQuestions } from "toy-jev"
import type { ResponseFormat } from "toy-llm"

/** 由 JEV 问题构造出的提示词与 JSON Schema。 */
export interface JevLlmPrompt {
  readonly systemMessage: string
  readonly responseFormat: ResponseFormat
}

/**
 * 把 JEV 问题翻译成给 LLM 的评估提示词和约束输出的 JSON Schema。
 * choice 的候选用 enum 锁死，减少模型乱答。
 */
export function buildPrompt(questions: JevQuestions): JevLlmPrompt {
  const answerSchemas: Record<string, unknown> = {}
  const lines: string[] = []
  let index = 0
  for (const [name, question] of Object.entries(questions)) {
    index += 1
    answerSchemas[name] = answerSchema(question)
    lines.push(`${index}. [${name}] ${describeQuestion(question)}`)
  }

  const systemMessage = [
    "你是一个严谨的结构化评估器。请阅读用户输入，只输出一个符合 JSON Schema 的对象，",
    "不要输出任何解释或多余文本。",
    "",
    "问题：",
    ...lines,
  ].join("\n")

  const responseFormat: ResponseFormat = {
    type: "json_schema",
    name: "jev",
    schema: {
      type: "object",
      properties: {
        answers: {
          type: "object",
          properties: answerSchemas,
          required: Object.keys(questions),
          additionalProperties: false,
        },
      },
      required: ["answers"],
      additionalProperties: false,
    },
    strict: true,
  }
  return { systemMessage, responseFormat }
}

/** 单个问题对应的答案 JSON Schema。 */
function answerSchema(question: JevQuestion): Record<string, unknown> {
  switch (question.type) {
    case "choice":
      return {
        type: "object",
        properties: {
          type: { const: "choice" },
          choice: { type: "string", enum: Object.keys(question.criteria) },
          confidence: { type: "number" },
          probabilities: { type: "object" },
        },
        required: ["type", "choice", "confidence", "probabilities"],
        additionalProperties: false,
      }
    case "score":
      return {
        type: "object",
        properties: {
          type: { const: "score" },
          score: { type: "number" },
          confidence: { type: "number" },
          legend: { type: "object" },
          probabilities: { type: "object" },
        },
        required: ["type", "score", "confidence", "legend", "probabilities"],
        additionalProperties: false,
      }
    case "noul":
      return {
        type: "object",
        properties: {
          type: { const: "noul" },
          noul: { type: "number" },
        },
        required: ["type", "noul"],
        additionalProperties: false,
      }
  }
}

/** 单行描述一个问题及其候选/标准。 */
function describeQuestion(question: JevQuestion): string {
  switch (question.type) {
    case "choice": {
      const options = Object.entries(question.criteria)
        .map(([key, label]) => `${key}=${label}`)
        .join("，")
      return `${question.instructions}（候选中选一个：${options}）`
    }
    case "score":
      return `${question.instructions}（评分标准：${question.criteria.join("；")}）`
    case "noul":
      return `${question.instructions}（输出 0 到 1 的连续值）`
  }
}
