/**
 * answer / judge 的 LLM 调用封装（对齐 REQUIREMENTS.md §7），统一取 token usage。
 *
 * 依赖 ctx.llm（由 runner 传入），不走 toy-memory-write 内部，因此能拿到真实 usage。
 */

/** answer 的 system prompt（§7）。 */
export const ANSWER_SYSTEM_MESSAGE =
  "你根据下面给出的记忆内容回答用户问题，只能依据记忆内容，不确定就回答「无法确定」。"

/** judge 的 JSON schema（§7：输出 { correct, reason }）。 */
export const JUDGE_JSON_SCHEMA = {
  type: "object",
  properties: {
    correct: { type: "boolean" },
    reason: { type: "string" },
  },
  required: ["correct", "reason"],
  additionalProperties: false,
}

/** 从 GenerateResult 抽出文本内容。 */
export function extractText(result) {
  return result.content
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("")
    .trim()
}

/** 归一化 usage 为 { inputTokens, outputTokens }（缺失记 0）。 */
export function normalizeUsage(usage) {
  return {
    inputTokens: usage?.inputTokens ?? 0,
    outputTokens: usage?.outputTokens ?? 0,
  }
}

/** 合并两段 usage。 */
export function sumUsage(a, b) {
  return {
    inputTokens: (a?.inputTokens ?? 0) + (b?.inputTokens ?? 0),
    outputTokens: (a?.outputTokens ?? 0) + (b?.outputTokens ?? 0),
  }
}

/**
 * 用检索到的记忆正文回答问题。
 *
 * @param {{ llm: { generate: Function } }} ctx Cordis 上下文。
 * @param {{ provider: string, model: string }} llmCfg 模型路由。
 * @param {string} question 题目。
 * @param {string} memoryText 检索到的 Fast/Long 正文。
 * @returns {Promise<{ predicted: string, usage: { inputTokens: number, outputTokens: number } }>}
 */
export async function answerQuestion(ctx, llmCfg, question, memoryText) {
  const result = await ctx.llm.generate({
    provider: llmCfg.provider,
    model: llmCfg.model,
    temperature: 0,
    reasoning: { enabled: false },
    messages: [
      { role: "system", content: [{ type: "text", text: ANSWER_SYSTEM_MESSAGE }] },
      { role: "user", content: [{ type: "text", text: `记忆内容：\n${memoryText}\n\n问题：${question}` }] },
    ],
  })
  return { predicted: extractText(result), usage: normalizeUsage(result.usage) }
}

/**
 * 判分：调用 LLM 输出 { correct, reason }。
 *
 * @param {{ llm: { generate: Function } }} ctx Cordis 上下文。
 * @param {{ provider: string, model: string }} llmCfg 模型路由。
 * @param {{ system: string, user: string }} judgePrompt adapter 生成的判分 prompt。
 * @returns {Promise<{ judge: { correct: boolean, reason: string }, usage: { inputTokens: number, outputTokens: number } }>}
 */
export async function judgeAnswer(ctx, llmCfg, judgePrompt) {
  const result = await ctx.llm.generate({
    provider: llmCfg.provider,
    model: llmCfg.model,
    temperature: 0,
    reasoning: { enabled: false },
    messages: [
      { role: "system", content: [{ type: "text", text: judgePrompt.system }] },
      { role: "user", content: [{ type: "text", text: judgePrompt.user }] },
    ],
    responseFormat: { type: "json_schema", name: "judge", schema: JUDGE_JSON_SCHEMA },
  })
  const text = extractText(result)
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    // 模型未按 JSON 输出时，按「判错」兜底，reason 记录原文。
    return {
      judge: { correct: false, reason: `judge 输出非 JSON：${text.slice(0, 200)}` },
      usage: normalizeUsage(result.usage),
    }
  }
  return {
    judge: {
      correct: parsed?.correct === true,
      reason: typeof parsed?.reason === "string" ? parsed.reason : "",
    },
    usage: normalizeUsage(result.usage),
  }
}
