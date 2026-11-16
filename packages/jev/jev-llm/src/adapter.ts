import {
  JevAdapter,
  JevError,
  JevResponseSchema,
  type JevProviderInfo,
  type JevRequest,
  type JevResponse,
} from "toy-jev"
import type { LlmFailure, LlmRuntime } from "toy-llm"
import { resolveConfig, type JevLlmConfig, type ResolvedJevLlmConfig } from "./config.js"
import { buildPrompt } from "./prompt.js"

/** LLM 侧可降级的临时失败码。 */
const RETRYABLE_CODES = new Set([
  "TRANSPORT",
  "TIMEOUT",
  "EMPTY_RESPONSE",
  "STREAM_CLOSED",
  "MALFORMED_STREAM",
])

function isRetryable(failure: LlmFailure): boolean {
  if (failure.code === "ABORTED") {
    return false
  }
  if (RETRYABLE_CODES.has(failure.code)) {
    return true
  }
  const status = failure.status
  return status === 408 || status === 429 || (status !== undefined && status >= 500)
}

/**
 * 把 JEV 请求桥接到 LLM：构造提示词 + JSON Schema，调用 `ctx.llm.generate`，
 * 再把结构化文本解析成 `JevResponse`。LLM 失败时抛 `JevError`，供 JEV 降级链继续兜底。
 */
export class JevLlmAdapter extends JevAdapter {
  readonly provider: string
  private readonly config: ResolvedJevLlmConfig
  private readonly llm: LlmRuntime

  constructor(llm: LlmRuntime, config: JevLlmConfig) {
    super()
    this.llm = llm
    this.config = resolveConfig(config)
    this.provider = this.config.provider
  }

  override providerInfo(provider: string): JevProviderInfo {
    return { id: provider, name: provider }
  }

  override async invoke(request: JevRequest): Promise<JevResponse> {
    const { systemMessage, responseFormat } = buildPrompt(request.questions)
    const generated = await this.llm.generate({
      provider: this.config.llmProvider,
      model: request.model,
      messages: [
        { role: "system", content: [{ type: "text", text: systemMessage }] },
        { role: "user", content: [{ type: "text", text: request.state }] },
      ],
      temperature: this.config.temperature,
      maxTokens: this.config.maxTokens,
      reasoning: { enabled: false },
      responseFormat,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    })

    if (generated.finish.kind === "aborted") {
      throw new JevError("JEV LLM 兜底已取消", "ABORTED", { cause: generated.finish.failure })
    }
    if (generated.finish.kind === "error") {
      throw this.mapLlmFailure(generated.finish.failure)
    }

    const text = generated.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("")
    const parsed = JevResponseSchema.safeParse({
      ...extractJson(text),
      model: request.model || this.config.llmProvider,
    })
    if (!parsed.success) {
      throw new JevError("JEV LLM 兜底返回的评估结果无效", "INVALID_RESPONSE", {
        cause: parsed.error,
      })
    }
    return {
      ...parsed.data,
      ...(generated.usage === undefined
        ? {}
        : {
            usage: {
              input_tokens: generated.usage.inputTokens,
              output_tokens: generated.usage.outputTokens,
            },
          }),
    }
  }

  private mapLlmFailure(failure: LlmFailure): JevError {
    if (failure.code === "FALLBACK_EXHAUSTED") {
      return new JevError("LLM 降级链已耗尽", "FALLBACK_EXHAUSTED", { cause: failure })
    }
    const retryable = isRetryable(failure)
    return new JevError(
      `JEV LLM 兜底失败：${failure.message}`,
      retryable ? "TRANSPORT" : "INVALID_REQUEST",
      { retryable, cause: failure },
    )
  }
}

/** 提取模型输出中的第一个 JSON 对象。 */
function extractJson(text: string): Record<string, unknown> {
  const trimmed = text.trim()
  const start = trimmed.indexOf("{")
  const end = trimmed.lastIndexOf("}")
  if (start < 0 || end < start) {
    throw new JevError("JEV LLM 兜底没有返回 JSON", "INVALID_RESPONSE")
  }
  let value: unknown
  try {
    value = JSON.parse(trimmed.slice(start, end + 1))
  } catch (error) {
    throw new JevError("JEV LLM 兜底返回的 JSON 无效", "INVALID_RESPONSE", { cause: error })
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new JevError("JEV LLM 兜底返回的不是 JSON 对象", "INVALID_RESPONSE")
  }
  return value as Record<string, unknown>
}
