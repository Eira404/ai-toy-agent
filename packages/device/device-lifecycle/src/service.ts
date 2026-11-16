import { Service, type Context } from "cordis"
import "toy-agent-loop"
import { DeviceError } from "toy-device"
import type { SessionJson } from "toy-session"
import { DEVICE_PRESETS_NODE, devicePresetsToSnapshot } from "./parse.js"
import { deviceSection } from "./prompt.js"

declare module "cordis" {
  interface Context {
    deviceContext: DeviceContext
  }
}

/** 玩偶上下文插件：session 预处理落库设备预设，并向 system prompt 注入人设/年龄片段。 */
export class DeviceContext extends Service {
  static inject = ["session", "systemPrompt", "device"]

  constructor(ctx: Context) {
    super(ctx, "deviceContext")

    ctx.effect(
      () =>
        ctx.session.preprocessing.register({
          name: DEVICE_PRESETS_NODE,
          process: ({ deviceId }) => this.resolvePresets(deviceId),
        }),
      "deviceContext.registerPreprocessing",
    )

    ctx.effect(
      () => ctx.systemPrompt.registerSection(deviceSection()),
      "deviceContext.registerSection",
    )
  }

  /** 读取设备预设；设备不存在时返回 null，不阻断会话创建。 */
  private async resolvePresets(deviceId: string): Promise<SessionJson> {
    try {
      const presets = await this.ctx.device.getDevicePresets(deviceId)
      return devicePresetsToSnapshot(presets)
    } catch (error) {
      if (error instanceof DeviceError && error.code === "device-not-found") {
        this.ctx.logger("device-context").warn("设备 '%s' 不存在，跳过玩偶预设", deviceId)
        return null
      }
      throw error
    }
  }
}

export default DeviceContext
