# toy-memory-lifecycle

在线记忆编排：把记忆系统注入 Session 与 Turn 生命周期。

- Session 预处理解析并保存当前娃娃的 active 记忆空间；
- Turn 预处理用 JEV 判断用户是否「明确要求记住」，据此分情况提取记忆；
- （可选）把提取结果作为系统提示片段注入，防止主模型虚假承诺。

本包不负责价值系统（feedback 结算引擎）——那由独立引擎另行注册。

## 职责与链路

```
createSession(userId, deviceId)
  └─ session.preprocessing["memory-space"]   ← memorySpace.resolveMemorySpace
        └─ payload.preprocessing["memory-space"] = { memorySpaceId }

每轮 Turn：
  └─ agentLoop.preprocessing["memory-gate"]
        ├─ JEV 判断 explicit / implicit
        ├─ explicit → 不提取，交给 memory_write 工具（由 toy-memory-tools 注入）
        └─ implicit → memoryWrite.extract(wait:"written")，返回 { explicit, extract, count }
  └─ 系统提示片段：按 extract 结果告知模型「已提取 / 未提取」，禁止虚假承诺
```

## 注册的节点

| 阶段 | 节点名 | 说明 |
|---|---|---|
| `session.preprocessing` | `memory-space` | 解析 `(userId, deviceId)` → memorySpaceId |
| `agentLoop.preprocessing` | `memory-gate` | JEV 门控 + 分情况提取（`wait:"written"`） |
| `systemPrompt` 片段 | `memory-extract-status` | 把提取结果注入 System（宿主需加载 `SystemPromptAssembler`） |

`memory-gate` 节点结果结构：

```ts
interface GateNodeResult {
  explicit: boolean
  extract: "started" | "written" | "empty" | "failed" | "no-space" | null
  count: number
}
```

## 配置

```ts
interface MemoryOnlineConfig {
  provider?: string   // JEV 路由名；省略时若只有一个 Adapter 自动选择
}
```

## 挂载

宿主先挂 `toy-jev`（注册 Adapter）、`toy-session`、`toy-agent-loop`、`toy-memory-space`、
`toy-memory-write`，再挂 `MemoryOnline`。若要提示片段生效，需在此之前加载 `SystemPromptAssembler`。

```ts
await ctx.plugin(JevRuntime)
ctx.jev.registerAdapter("main", adapter)
await ctx.plugin(MemorySpaceService)
await ctx.plugin(FastWrite, { llmProvider, llmModel })
await ctx.plugin(SystemPromptAssembler)   // 可选：提示片段
await ctx.plugin(MemoryOnline, { provider: "main" })
```

## 测试

```sh
npm test -w toy-memory-lifecycle
```

测试用假 JEV Adapter 覆盖 explicit / implicit 两种门控、提取落库、scope 解析与提示片段三态渲染。
