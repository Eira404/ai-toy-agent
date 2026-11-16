/** `toy-memory-space` 的错误码。 */
export type MemorySpaceErrorCode =
  /** 调用方输入非法（空 ID、非法名字等）。 */
  | "invalid-input"
  /** 命名关系型存储实例尚未就绪。 */
  | "source-not-ready"
  /** 数据源 schema 与本包定义不一致。 */
  | "schema-mismatch"
  /** 目标空间不存在。 */
  | "space-not-found"
  /** 对已删除空间执行 active 专属操作（bind/rename）。 */
  | "space-deleted"
  /** 调用方 userId 不是空间所有者。 */
  | "not-owner"
  /** unbind 时目标娃娃没有绑定任何空间。 */
  | "binding-not-found"

/** Space 包统一抛出的业务错误，携带稳定错误码供上层区分处理。 */
export class MemorySpaceError extends Error {
  readonly code: MemorySpaceErrorCode

  constructor(code: MemorySpaceErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = "MemorySpaceError"
    this.code = code
  }
}
