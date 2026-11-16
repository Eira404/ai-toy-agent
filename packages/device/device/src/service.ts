import { Service, type Context } from "cordis"
import "toy-debug-device"
import { gradeAge } from "./age-grades.js"
import { DeviceError } from "./error.js"
import type { DevicePresets } from "./types.js"

declare module "cordis" {
  interface Context {
    device: DeviceService
  }
}

/** 玩偶（设备）业务门面：从 debug 设备存储读取玩偶的年龄分级与人设预设。 */
export class DeviceService extends Service {
  static inject = ["debugDevices"]

  constructor(ctx: Context) {
    super(ctx, "device")
  }

  /**
   * 读取指定玩偶的预设快照：透传 debug 设备记录里的年龄与人设，并附加年龄分级。
   * @param deviceId 玩偶（设备）ID。
   */
  async getDevicePresets(deviceId: string): Promise<DevicePresets> {
    if (typeof deviceId !== "string" || deviceId.trim().length === 0) {
      throw new DeviceError("invalid-input", "deviceId 必须是非空字符串")
    }
    const device = await this.ctx.debugDevices.getDevice(deviceId)
    if (device === undefined) {
      throw new DeviceError("device-not-found", `设备 '${deviceId}' 不存在`)
    }
    return {
      deviceId: device.deviceId,
      agePreset: device.age,
      ageGrade: gradeAge(device.age),
      personaPreset: device.persona,
    }
  }
}

export default DeviceService
