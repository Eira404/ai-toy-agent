import { WriteQueueError } from "./error.js"
import type { QueuedWriteJob, WriteWaitOptions } from "./types.js"

const QUEUE_NAME_RE = /^[a-z][a-z0-9_-]*$/

/**
 * 校验任务标识，并为队列保存一份独立的操作快照。
 *
 * @param job 业务插件提交的待写操作。
 * @returns 已复制、不会受调用方后续修改影响的任务。
 */
export function snapshotJob<Operation>(job: QueuedWriteJob<Operation>): QueuedWriteJob<Operation> {
  assertQueueName(job.queueName)
  if (typeof job.jobId !== "string" || job.jobId.length === 0 || job.jobId.length > 256) {
    throw new WriteQueueError("invalid-job", "jobId 必须是长度 1 到 256 的字符串")
  }
  if (job.target === null || typeof job.target !== "object") {
    throw new WriteQueueError("invalid-job", "target 必须指定存储类别和名称")
  }
  let operation: Operation
  try {
    // 入队和执行之间可能相隔很久，不能继续引用调用方可修改的原对象。
    operation = structuredClone(job.operation)
  } catch (error) {
    throw new WriteQueueError("invalid-job", "operation 必须是可复制的数据", { cause: error })
  }
  return Object.freeze({
    jobId: job.jobId,
    queueName: job.queueName,
    target: Object.freeze({ kind: job.target.kind, name: job.target.name }),
    operation,
  })
}

/** @param queueName 逻辑队列名；省略表示全部队列。 */
export function assertQueueName(queueName: string): void {
  if (typeof queueName !== "string" || !QUEUE_NAME_RE.test(queueName)) {
    throw new WriteQueueError("invalid-job", `queueName '${queueName}' 必须匹配 ${QUEUE_NAME_RE}`)
  }
}

/**
 * @param options 等待的取消和超时参数。
 * @returns 参数有效时无返回值。
 */
export function assertWaitOptions(options: WriteWaitOptions): void {
  if (
    options.timeoutMs !== undefined &&
    (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1)
  ) {
    throw new WriteQueueError("invalid-job", "timeoutMs 必须是正安全整数")
  }
}

/** 用 JSON 元组编码，避免队列名和任务 ID 中的分隔符造成碰撞。 */
export function jobKey(queueName: string, jobId: string): string {
  return JSON.stringify([queueName, jobId])
}

/** 两种不同存储类型中允许使用相同的实例名称。 */
export function targetKey(kind: string, name: string): string {
  return JSON.stringify([kind, name])
}
