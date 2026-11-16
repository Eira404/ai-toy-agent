/** 玩偶（设备）业务门面对外稳定暴露的错误类别。 */
export type DeviceErrorCode = "invalid-input" | "device-not-found"

/** 业务层可根据 code 区分输入与状态错误。 */
export class DeviceError extends Error {
  constructor(
    readonly code: DeviceErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = "DeviceError"
  }
}
