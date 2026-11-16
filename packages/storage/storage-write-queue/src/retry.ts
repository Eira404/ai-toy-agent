import { WriteQueueError } from "./error.js"

/** 只按目标实例明确声明的安全性重试；未知提交状态永不自动重试。 */
export function shouldRetry(error: unknown): boolean {
  if (error instanceof WriteQueueError && error.code === "target-unavailable") {
    return true
  }
  if (error === null || typeof error !== "object") {
    return false
  }
  const candidate = error as { retryable?: unknown; unknownState?: unknown }
  return candidate.unknownState !== true && candidate.retryable === true
}

/**
 * 为临时故障生成有上限的指数退避时间。
 *
 * @param failures 本任务连续失败次数，从 1 开始。
 * @param baseMs 第一次重试等待毫秒数。
 * @param maxMs 最大等待毫秒数。
 * @returns 下次调度前的等待毫秒数。
 */
export function retryDelay(failures: number, baseMs: number, maxMs: number): number {
  return Math.min(maxMs, baseMs * 2 ** Math.min(failures - 1, 30))
}
