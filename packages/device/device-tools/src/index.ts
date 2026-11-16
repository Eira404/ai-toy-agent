import { Service, type Context } from "cordis"
import type { ToolExecutionContext, ToolJsonValue } from "toy-tools"

declare module "cordis" {
  interface Context {
    deviceTools: DeviceTools
  }
}

/** 把输出音量设置为绝对值的稳定命令。 */
export interface SetOutputVolumeCommand {
  readonly name: "set_output_volume"
  readonly arguments: { readonly level: number }
}

/** 相对调高或调低输出音量的稳定命令。 */
export interface AdjustOutputVolumeCommand {
  readonly name: "adjust_output_volume"
  readonly arguments: { readonly delta: number }
}

/** 查询输出音量与静音状态的稳定命令。 */
export interface GetOutputVolumeCommand {
  readonly name: "get_output_volume"
  readonly arguments: Readonly<Record<string, never>>
}

/** 查询电量、充电状态与供电来源的稳定命令。 */
export interface GetBatteryStatusCommand {
  readonly name: "get_battery_status"
  readonly arguments: Readonly<Record<string, never>>
}

/** 插件向外部执行端提交的稳定设备命令联合。 */
export type DeviceToolCommand =
  | SetOutputVolumeCommand
  | AdjustOutputVolumeCommand
  | GetOutputVolumeCommand
  | GetBatteryStatusCommand

/**
 * 设备命令发送端口。设备协议尚未确定时由装配方实现，可转发到 HTTP、MQTT 或设备服务；
 * 返回值会作为 tool result 交给模型。
 */
export type DeviceDispatcher = (
  command: DeviceToolCommand,
  context: ToolExecutionContext,
) => ToolJsonValue | void | Promise<ToolJsonValue | void>

export interface DeviceToolsConfig {
  /**
   * 真实设备传输。省略时使用内置 dry-run：只打印命令并返回未配置标记，
   * 不会向真实设备发送请求，也不会伪造设备成功状态。
   */
  readonly dispatch?: DeviceDispatcher
}

/**
 * v4 的 ToolScope 由工具系统默认提供 `{ userId, deviceId, sessionId, turnId }`，
 * 但不含 v3 的 principal.scopes / device.capabilities，因此当前四个工具默认可用。
 * 待设备能力模型落地后，再用 `isAvailable(scope, payload)` 接回
 * `device:read` / `device:control` 与 `audio.output-volume.*`、`battery.read` 等能力门控。
 */
function dryRunDispatch(command: DeviceToolCommand, context: ToolExecutionContext): ToolJsonValue {
  return {
    status: "DEVICE_TRANSPORT_NOT_CONFIGURED",
    deviceId: context.deviceId,
    command: command.name,
  }
}

/**
 * 设备工具插件：注册音量（设置/调整/查询）与电量查询四个本地工具。
 *
 * 本插件不决定设备命令发给谁、用什么协议；装配方通过 `config.dispatch` 接入 HTTP、MQTT、
 * 本机 SDK 或未来的设备服务。未提供 dispatch 时走 dry-run，便于先跑通工具链路。
 */
export class DeviceTools extends Service {
  static inject = ["tools"]

  constructor(ctx: Context, config: DeviceToolsConfig = {}) {
    super(ctx, "deviceTools")
    const dispatch = config.dispatch ?? dryRunDispatch

    ctx.effect(() => {
      const disposers = [
        ctx.tools.register({
          name: "set_output_volume",
          description: "把当前设备的输出音量设置为 0 到 100 的绝对值",
          parameters: {
            type: "object",
            properties: {
              level: { type: "integer", minimum: 0, maximum: 100, description: "目标音量" },
            },
            required: ["level"],
            additionalProperties: false,
          },
          execute: (args, context) =>
            dispatch(
              { name: "set_output_volume", arguments: { level: (args as { level: number }).level } },
              context,
            ),
        }),
        ctx.tools.register({
          name: "adjust_output_volume",
          description: "相对调高或调低当前设备的输出音量",
          parameters: {
            type: "object",
            properties: {
              delta: {
                type: "integer",
                minimum: -100,
                maximum: 100,
                not: { const: 0 },
                description: "音量变化量，负数调低、正数调高，不能为 0",
              },
            },
            required: ["delta"],
            additionalProperties: false,
          },
          execute: (args, context) =>
            dispatch(
              { name: "adjust_output_volume", arguments: { delta: (args as { delta: number }).delta } },
              context,
            ),
        }),
        ctx.tools.register({
          name: "get_output_volume",
          description: "查询当前设备的输出音量和静音状态",
          parameters: { type: "object", properties: {}, additionalProperties: false },
          execute: (_args, context) => dispatch({ name: "get_output_volume", arguments: {} }, context),
        }),
        ctx.tools.register({
          name: "get_battery_status",
          description: "查询当前设备的电量、充电状态和供电来源",
          parameters: { type: "object", properties: {}, additionalProperties: false },
          execute: (_args, context) => dispatch({ name: "get_battery_status", arguments: {} }, context),
        }),
      ]
      return () => {
        for (const dispose of disposers.reverse()) {
          dispose()
        }
      }
    }, "deviceTools.register")
  }
}

export default DeviceTools
