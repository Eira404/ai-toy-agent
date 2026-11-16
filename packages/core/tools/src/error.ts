/** 注册工具时可用于程序判断的错误码。 */
export type ToolErrorCode = "INVALID_TOOL" | "INVALID_SCHEMA" | "DUPLICATE_TOOL"

/** 工具定义或注册冲突产生的错误。 */
export class ToolError extends Error {
  override readonly name = "ToolError"

  constructor(
    message: string,
    readonly code: ToolErrorCode,
    options?: ErrorOptions,
  ) {
    super(message, options)
  }
}
