/** `toy-memory-fast` 的错误码。 */
export type FastMemoryErrorCode =
  /** 调用方输入非法（空 ID、空草稿、超长字段等）。 */
  | "invalid-input"
  /** 命名存储实例尚未就绪。 */
  | "source-not-ready"
  /** Embedding 服务未挂载或路由不存在。 */
  | "embedding-not-ready"
  /** 向量维度与集合声明不一致。 */
  | "dimension-mismatch"
  /** 消费计划校验失败（fastIds 与查询结果不一致）。 */
  | "consume-mismatch"

/** Fast 包统一抛出的业务错误，携带稳定错误码供上层区分处理。 */
export class FastMemoryError extends Error {
  readonly code: FastMemoryErrorCode

  constructor(code: FastMemoryErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = "FastMemoryError"
    this.code = code
  }
}
