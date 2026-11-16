import { ParallelError } from "./error.js"
import type { RetryPolicy, TaskPolicy, TaskPoolConfig } from "./types.js"

export interface ResolvedRetry {
  maxAttempts: number
  shouldRetry: RetryPolicy["shouldRetry"]
  baseDelayMs: number
  maxDelayMs: number
  jitter: boolean
  retryAfterMs: RetryPolicy["retryAfterMs"]
}

export interface ResolvedPolicy {
  queueTimeoutMs: number | null
  attemptTimeoutMs: number | null
  totalTimeoutMs: number | null
  retry: ResolvedRetry | false
}

export interface ResolvedPool extends ResolvedPolicy {
  maxConcurrency: number
  maxQueueSize: number
}

export const MAX_TIMER_MS = 2_147_483_647

export function invalid(message: string): never {
  throw new ParallelError("INVALID_OPTIONS", message)
}

export function integer(value: number, name: string, minimum = 1): number {
  if (!Number.isSafeInteger(value) || value < minimum) {
    invalid(`${name} 必须是 >= ${minimum} 的安全整数`)
  }
  return value
}

export function label(value: string, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    invalid(`${name} 不能为空`)
  }
  return value.trim()
}

export function timeout(value: number | null, name: string): number | null {
  if (value !== null && integer(value, name) > MAX_TIMER_MS) {
    invalid(`${name} 不能超过 ${MAX_TIMER_MS}`)
  }
  return value
}

export function resolvePolicy(input: TaskPolicy, base?: ResolvedPolicy): ResolvedPolicy {
  const retry = input.retry === undefined ? (base?.retry ?? false) : resolveRetry(input.retry)
  return Object.freeze({
    queueTimeoutMs: timeout(
      input.queueTimeoutMs === undefined
        ? base === undefined
          ? 30_000
          : base.queueTimeoutMs
        : input.queueTimeoutMs,
      "queueTimeoutMs",
    ),
    attemptTimeoutMs: timeout(
      input.attemptTimeoutMs === undefined
        ? (base?.attemptTimeoutMs ?? null)
        : input.attemptTimeoutMs,
      "attemptTimeoutMs",
    ),
    totalTimeoutMs: timeout(
      input.totalTimeoutMs === undefined ? (base?.totalTimeoutMs ?? null) : input.totalTimeoutMs,
      "totalTimeoutMs",
    ),
    retry,
  })
}

export function resolvePool(input: TaskPoolConfig): ResolvedPool {
  return Object.freeze({
    ...resolvePolicy(input),
    maxConcurrency: integer(input.maxConcurrency, "maxConcurrency"),
    maxQueueSize: integer(input.maxQueueSize ?? 1000, "maxQueueSize", 0),
  })
}

function resolveRetry(input: RetryPolicy | false): ResolvedRetry | false {
  if (input === false) {
    return false
  }
  if (typeof input.shouldRetry !== "function") {
    invalid("retry.shouldRetry 必须是函数")
  }
  if (input.retryAfterMs !== undefined && typeof input.retryAfterMs !== "function") {
    invalid("retry.retryAfterMs 必须是函数")
  }
  if (input.jitter !== undefined && typeof input.jitter !== "boolean") {
    invalid("retry.jitter 必须是布尔值")
  }
  const baseDelayMs = timeout(input.baseDelayMs ?? 500, "retry.baseDelayMs")!
  const maxDelayMs = timeout(input.maxDelayMs ?? 10_000, "retry.maxDelayMs")!
  if (baseDelayMs > maxDelayMs) {
    invalid("retry.baseDelayMs 不能超过 retry.maxDelayMs")
  }
  return Object.freeze({
    maxAttempts: integer(input.maxAttempts, "retry.maxAttempts"),
    shouldRetry: input.shouldRetry,
    baseDelayMs,
    maxDelayMs,
    jitter: input.jitter ?? true,
    retryAfterMs: input.retryAfterMs,
  })
}
