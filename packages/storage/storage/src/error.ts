/** 命名实例注册与查找的稳定错误码。 */
export type StorageErrorCode =
  "invalid-identity" | "invalid-instance" | "duplicate-source" | "source-not-found"

/** 通用存储注册中心的错误；不包含数据库驱动的错误细节。 */
export class StorageError extends Error {
  /**
   * @param code 稳定错误码。
   * @param message 供开发者排查的中文诊断信息。
   */
  constructor(
    readonly code: StorageErrorCode,
    message: string,
  ) {
    super(message)
    this.name = "StorageError"
  }
}
