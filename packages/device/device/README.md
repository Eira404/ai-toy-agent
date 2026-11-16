# toy-device

玩偶（设备）业务门面，挂载到 `ctx.device`。目前只做一件事：调用 debug 的玩偶存储
（`toy-debug-device`），按 `deviceId` 读取玩偶的**年龄预设**与**人设预设**，并附加一个**年龄分级**。

## 职责

- 透传 `toy_debug_devices` 里已存的 `age`（孩子岁数）与 `persona`（玩偶人设文本）。
- 把年龄换算为年龄分级（`ageGrade`），供装配方注入 system prompt 或做交互策略。
- 不写库、不改数据，只读取与派生。

## 依赖链

必须先挂载 `toy-debug-device`（内部依赖 `ctx.debugDevices`），随后挂载本插件。

```js
import { Context } from "cordis"
import { DebugDevices } from "toy-debug-device"
import { DeviceService } from "toy-device"

const ctx = new Context()
// …存储插件与命名关系型 adapter（含 debug 设备表）先挂载…
await ctx.plugin(DebugDevices, { sourceName: "main" })
await ctx.plugin(DeviceService)

const presets = await ctx.device.getDevicePresets("device-d1")
// { deviceId, agePreset, ageGrade: { id, label, minAge, maxAge, description }, personaPreset }
```

## API

### `getDevicePresets(deviceId)`

返回 `DevicePresets`：

| 字段            | 说明                                                                            |
| --------------- | ------------------------------------------------------------------------------- |
| `deviceId`      | 玩偶（设备）ID                                                                  |
| `agePreset`     | 透传 `device.age`（孩子岁数）；`null` 表示未设置                                |
| `ageGrade`      | 由年龄换算出的年龄分级；年龄未设置时为 `null`                                   |
| `personaPreset` | 透传 `device.persona`（可直接注入 system prompt 的完整文本）；`null` 表示无人设 |

设备不存在时抛 `DeviceError("device-not-found")`；`deviceId` 为空时抛
`DeviceError("invalid-input")`。

## 年龄分级

| id             | label      | 范围        | 说明                                           |
| -------------- | ---------- | ----------- | ---------------------------------------------- |
| `infant`       | 婴幼儿     | 0–3 岁      | 语言启蒙期，用词简短、多重复、多用拟声与韵律   |
| `preschool`    | 学龄前     | 4–6 岁      | 具体形象思维，喜欢童话、绘本与游戏化表达       |
| `early-school` | 小学低年级 | 7–9 岁      | 开始识字与独立阅读，适合简单科普与好奇问答     |
| `late-school`  | 小学高年级 | 10–12 岁    | 逻辑与兴趣拓展期，可进行更完整、有条理的解释   |
| `teen`         | 青少年     | 13–17 岁    | 抽象思维发展，适合更成熟、平等且尊重隐私的对话 |
| `adult`        | 成人       | 18 岁及以上 | 常规成人对话                                   |

分级目录与换算函数由 `AGE_GRADES` 与 `gradeAge` 导出，边界含端点、无重叠、覆盖所有非负整数岁。

## 说明

本包当前依赖 `toy-debug-device`，因此只能在 `DEBUG_BACKEND=1`（挂载了 `DebugDevices`）时使用。
后续接入生产设备数据源时，把 `inject` 目标换成生产侧设备服务即可，透传与分级逻辑不变。
