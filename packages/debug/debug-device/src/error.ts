/** Debug 设备存储对外稳定暴露的错误类别。 */
export type DebugDeviceErrorCode =
  | "invalid-input"
  | "device-exists"
  | "device-not-found"
  | "source-not-ready"
  | "schema-mismatch"

/** 业务层可根据 code 区分输入、状态和持久化错误。 */
export class DebugDeviceError extends Error {
  constructor(
    readonly code: DebugDeviceErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = "DebugDeviceError"
  }
}
