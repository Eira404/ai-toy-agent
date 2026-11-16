# toy-device-tools

音量与电量设备工具的本地插件，挂载到 `ctx.deviceTools`。它向 `ctx.tools` 注册四个工具：

- `set_output_volume`：把输出音量设置为 0..100 的绝对值
- `adjust_output_volume`：相对调高/调低音量（`delta` 不能为 0）
- `get_output_volume`：查询输出音量和静音状态
- `get_battery_status`：查询电量、充电状态和供电来源

本插件不决定设备命令发给谁、用什么协议；装配方通过 `config.dispatch(command, context)` 接入
HTTP、MQTT、本机 SDK 或未来的设备服务。

```ts
import { DeviceTools } from "toy-device-tools"

// 未来接真实设备时提供 dispatch；返回值会作为 tool result 交给模型。
await ctx.plugin(DeviceTools, {
  async dispatch(command, context) {
    // context 里带 userId/deviceId/sessionId/turnId/toolCallId，以及可选 signal 与 record()。
    return deviceExecutor.execute(command)
  },
})

// 暂不接真实设备时省略 config，走内置 dry-run：只打印命令并返回
// { status: "DEVICE_TRANSPORT_NOT_CONFIGURED", ... }，不伪造设备成功状态。
await ctx.plugin(DeviceTools)
```

参数校验（0..100、-100..100、`delta != 0`、未知字段）已下沉到工具 `parameters` 的 JSON Schema，
由 `toy-tools` 的 Ajv 统一执行，非法参数不会进入 `dispatch`。

`ToolScope`（`userId/deviceId/sessionId/turnId`）由工具系统默认提供；设备能力模型落地前，四个
工具默认可用。后续可补 `isAvailable(scope, payload)` 做 `device:read` / `device:control` 与
`audio.output-volume.*`、`battery.read` 的能力门控。

## 挂载顺序

```text
ToolRegistry → DeviceTools（→ LlmRuntime → AgentService → AgentLoop）
```

[测试](./test/device-tools.test.mjs) 覆盖 dry-run、自定义 dispatch 转发与参数校验拦截。
