import { z } from "zod"
import { JevError } from "./error.js"
import { JevResponseSchema, type JevQuestions, type JevResponse } from "./schema.js"

/**
 * 校验适配器响应的结构和请求语义。
 *
 * @param questions 已校验的问题。
 * @param response 适配器返回的原始数据。
 * @returns 形状、名称和类型都与请求匹配的响应。
 */
export function validateAnswers(questions: JevQuestions, response: unknown): JevResponse {
  const parsed = JevResponseSchema.safeParse(response)
  if (!parsed.success) {
    throw new JevError(`JEV 响应格式无效：${z.prettifyError(parsed.error)}`, "INVALID_RESPONSE")
  }
  const { answers } = parsed.data
  for (const [name, question] of Object.entries(questions)) {
    const answer = Object.hasOwn(answers, name) ? answers[name] : undefined
    if (answer?.type !== question.type) {
      throw new JevError(`JEV 缺少 '${name}' 的 ${question.type} 答案`, "INVALID_RESPONSE")
    }
    if (
      question.type === "choice" &&
      answer.type === "choice" &&
      !Object.hasOwn(question.criteria, answer.choice)
    ) {
      throw new JevError(`JEV '${name}' 的答案超出候选范围`, "INVALID_RESPONSE")
    }
  }
  if (Object.keys(answers).length !== Object.keys(questions).length) {
    throw new JevError("JEV 响应包含未请求的答案", "INVALID_RESPONSE")
  }
  return parsed.data
}
