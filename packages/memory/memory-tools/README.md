# toy-memory-tools

记忆系统的本地工具插件，向主模型注册 `memory_read` 与 `memory_write` 两个 function tool。

## 工具

| 工具           | 可用性      | 行为                                                                        |
| -------------- | ----------- | --------------------------------------------------------------------------- |
| `memory_read`  | 常驻        | 检索 Fast + Long，返回精简正文；只记录 Long 价值单元供 feedback 登记召回    |
| `memory_write` | 按 JEV 门控 | 仅当本轮用户「明确要求记住」时注入；直接落库主模型给出的 title/summary/body |

`memory_write` 的可用性由 `toy-memory-lifecycle` 的 Turn 预处理节点 `memory-gate` 决定：
`isAvailable` 读取 `preprocessing.data["memory-gate"].explicit`，为 `true` 时才注入。

## 数据流

```
memory_read 调用
  ├─ memorySpace.resolveMemorySpace(userId, deviceId) → scope
  ├─ memoryRead.search(scope, query, mode)
  ├─ context.record({ units })   // Long 单元 ID + recalledContent 正文快照
  └─ 返回精简正文 JSON

memory_write 调用（仅 explicit 时可用）
  ├─ memorySpace.resolveMemorySpace → scope
  └─ memoryWrite.write(scope, sessionId, turnId, drafts)
```

`collectRecallUnits` 返回的 `RecallUnit[]` 与 `toy-memory-feedback` 共用同一类型：

- overview：`recalledContent: { title, summary, overviewBody }`；
- detail：`recalledContent: { summary, body }`。

这些字段直接来自同一次 `memoryRead.search()` 返回值，记录到 `tool_result.data.units`。
交给模型的 Long 概述采用相同字段，`details` 返回 `{ summary, body }[]`，因此事件快照与
模型实际收到的正文一致。Session 收尾提取器使用事件的 `data.units`，不重新查询 Long。

## 配置

```ts
interface MemoryToolsConfig {
  readToolName?: string // 默认 "memory_read"
  writeToolName?: string // 默认 "memory_write"
}
```

## 挂载

宿主先挂 `toy-tools`、`toy-memory-read`、`toy-memory-write`、`toy-memory-space`，再挂 `MemoryTools`：

```ts
await ctx.plugin(ToolRegistry)
await ctx.plugin(MemoryRead, { embeddingProvider, embeddingModel })
await ctx.plugin(FastWrite, { llmProvider, llmModel })
await ctx.plugin(MemorySpaceService)
await ctx.plugin(MemoryTools)
```

## 测试

```sh
npm test -w toy-memory-tools
```

测试用假 memoryRead/memoryWrite/memorySpace 覆盖工具注入门控、检索召回记录与写库。
