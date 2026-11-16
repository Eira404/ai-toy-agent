/** `toy-memory-long` 的错误码。 */
export type LongMemoryErrorCode =
  /** 调用方输入非法（空 ID、重复变更、非法枚举等）。 */
  | "invalid-input"
  /** 目标块不存在或不属于该空间。 */
  | "block-not-found"
  /** 目标细节不存在或不属于该块。 */
  | "detail-not-found"
  /** applyChanges 的 old 信息与库中不一致，应触发上层整体重试。 */
  | "conflict"
  /** 同一变更集合内出现重复的块或细节操作。 */
  | "duplicate-change"
  /** 命名存储实例尚未就绪。 */
  | "source-not-ready"
  /** 数据源 schema 与本包定义不一致。 */
  | "schema-mismatch"

/** Long 包统一抛出的业务错误，携带稳定错误码供上层区分处理。 */
export class LongMemoryError extends Error {
  readonly code: LongMemoryErrorCode

  constructor(code: LongMemoryErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = "LongMemoryError"
    this.code = code
  }
}
