# toy-device-lifecycle

玩偶上下文插件，挂载到 `ctx.deviceContext`。它把玩偶的年龄与人设接入到 Agent 的两处：

1. **session 预处理**：注册 `device-presets` 节点，在 `createSession` 时按 `deviceId` 调
   `toy-device` 的 `getDevicePresets`，把结果快照进 `session.payload.preprocessing["device-presets"]`。
2. **system prompt 片段**：注册 `device-persona` 片段，从 session payload 读出预设，渲染
   「玩偶人设」与「面向年龄段」两段 SP 交给模型。

## 依赖链

需先挂载 `toy-session`、`toy-agent-loop` 的 `SystemPromptAssembler` 与 `toy-device`：

```js
import { Context } from "cordis"
import { SessionData } from "toy-session-data"
import { ToySession } from "toy-session"
import { AgentService } from "toy-agent"
import { AgentLoop, SystemPromptAssembler } from "toy-agent-loop"
import { DeviceService } from "toy-device"
import { DeviceContext } from "toy-device-lifecycle"

const ctx = new Context()
await ctx.plugin(SessionData)
await ctx.plugin(ToySession)
await ctx.plugin(AgentService)
await ctx.plugin(AgentLoop)
await ctx.plugin(SystemPromptAssembler)
// …存储与 toy-debug-device（提供 ctx.device）…
await ctx.plugin(DeviceService)
await ctx.plugin(DeviceContext)

const sessionId = await ctx.session.createSession({ userId: "u1", deviceId: "d1" })
// session.payload.preprocessing["device-presets"] 已包含 { agePreset, ageGrade, personaPreset }
```

## 语义

- 预设只在**创建 session 时快照一次**，整段会话内不变。
- 设备在 debug 存储里不存在时：`device-presets` 节点存 `null`，**不阻断**会话创建，SP 片段自动跳过。
- 人设映射：内置 `PERSONA_CATALOG`，按 `personaPreset` 文本精确命中目录项；未命中用原文兜底包一层。
- 年龄 SP：复用 `toy-device` 的 `AGE_GRADES`，直接渲染 `ageGrade.description`。

## 导出

| 导出                                                                     | 说明           |
| ------------------------------------------------------------------------ | -------------- |
| `DeviceContext`                                                          | 插件本体       |
| `PERSONA_CATALOG`                                                        | 本地人设目录   |
| `renderPersona` / `renderDeviceSection` / `deviceSection`                | 渲染辅助       |
| `devicePresetsToSnapshot` / `parseDevicePresets` / `DEVICE_PRESETS_NODE` | 快照与解析辅助 |
