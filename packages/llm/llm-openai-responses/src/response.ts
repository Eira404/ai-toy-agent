import { LlmError, type FinishReason, type TokenUsage } from "toy-llm"
import type { WireItem } from "./continuation.js"

/** 收窄未知 JSON，用于解析 SSE 事件和完整响应。 */
export function object(value: unknown, label: string): WireItem {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new LlmError(`${label} 不是对象`, "MALFORMED_RESPONSE")
  }
  return value as WireItem
}

/** Responses 的用量字段与统一 Token 统计之间的转换。 */
export function usageOf(raw: unknown): TokenUsage | undefined {
  if (raw === undefined || raw === null) {
    return undefined
  }
  const usage = object(raw, "response.usage")
  const input = optionalObject(usage.input_tokens_details)
  const output = optionalObject(usage.output_tokens_details)
  return {
    inputTokens: count(usage.input_tokens) ?? 0,
    outputTokens: count(usage.output_tokens) ?? 0,
    ...optionalCount("totalTokens", usage.total_tokens),
    ...optionalCount("cachedInputTokens", input?.cached_tokens),
    ...optionalCount("reasoningTokens", output?.reasoning_tokens),
  }
}

/** 将成功、不完整和失败的终止事件映射为统一结束原因。 */
export function finishReason(
  type: string,
  response: WireItem,
  callIds: readonly string[],
): FinishReason {
  if (type === "response.completed") {
    return { kind: callIds.length > 0 ? "tool-calls" : "stop" }
  }
  if (type === "response.incomplete") {
    const reason = optionalObject(response.incomplete_details)?.reason
    if (reason === "max_output_tokens") {
      return { kind: "max-tokens" }
    }
    return {
      kind: "error",
      failure: {
        code: reason === "content_filter" ? "CONTENT_FILTER" : "INCOMPLETE_RESPONSE",
        message: typeof reason === "string" ? `Responses 未完成：${reason}` : "Responses 未完成",
      },
    }
  }
  const error = optionalObject(response.error)
  return { kind: "error", failure: failureOf(error ?? {}, "Responses 请求失败") }
}

/** 从失败事件提取稳定的诊断字段。 */
export function failureOf(error: WireItem, fallback: string): { code: string; message: string } {
  return {
    code: typeof error.code === "string" ? error.code : "PROVIDER_ERROR",
    message: typeof error.message === "string" ? error.message : fallback,
  }
}

function optionalObject(value: unknown): WireItem | undefined {
  return value === undefined || value === null ? undefined : object(value, "响应字段")
}

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined
}

function optionalCount<K extends keyof TokenUsage>(
  key: K,
  value: unknown,
): Partial<Record<K, number>> {
  const parsed = count(value)
  return parsed === undefined ? {} : ({ [key]: parsed } as Record<K, number>)
}
