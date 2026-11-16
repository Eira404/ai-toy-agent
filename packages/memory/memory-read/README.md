# toy-memory-read

记忆联合检索编排。接收主 Agent 提供的专用检索 Query 与 Long 强弱模式，共享一次 Query Embedding，并行调用 Fast 与 Long，返回两组完整正文与整体降级状态。

read 只做编排，不生成记忆内容、不做召回记录（那是 `toy-memory-feedback` 的职责）、不读对话改写 Query、不判断或切换强弱模式。

## 职责与链路

```
专用检索 Query + 强弱模式
  ↓
共享 Query Embedding（一次；失败降级为 null）
  ↓ 并行
  ├─ Fast.search({ scope, query, queryVector })
  └─ Long.searchWeak / searchStrong({ scope, query, queryVector })
  ↓
汇总整体状态，返回 { status, fast, long }
```

- `fast` / `long` 直接透传下层结果，命中项里已带 ID + 命中原因 + 分数，供 feedback 登记召回。
- 分支失败只重试该分支，达到尝试次数或整次截止时间后降级为占位结果，不阻断主 Agent 问答。

## 方法

| 方法 | 说明 |
|---|---|
| `search(input)` | 执行一次联合检索，返回 Fast/Long 两组结果与整体状态 |

```ts
search(input: ReadSearchInput): Promise<ReadSearchResult>

interface ReadSearchInput {
  scope: Scope
  query: string                 // 专用检索 Query，不改写
  mode: "weak" | "strong"       // 只影响 Long
}

interface ReadSearchResult {
  status: "COMPLETE" | "PARTIAL" | "UNAVAILABLE"
  fast: FastSearchResult
  long: LongSearchResult
}
```

## 整体状态

| 场景 | status |
|---|---|
| Embedding 成功，Fast/Long 所有应执行分支成功（允许空结果） | `COMPLETE` |
| Embedding 失败（向量分支降级）但 title/alias 有命中 | `PARTIAL` |
| 任一分支失败但仍有可信结果 | `PARTIAL` |
| 所有分支失败且无结果 | `UNAVAILABLE` |

> Embedding 失败本身就让结果降级为 `PARTIAL`（即使 title 匹配全成功），因为向量分支未执行。

## 配置

```ts
interface ReadConfig {
  embeddingProvider: string   // 必填，Embedding 路由名
  embeddingModel: string      // 必填，Embedding 模型名

  maxAttempts?: number        // 每分支最大尝试次数（含首次），默认 2
  deadlineMs?: number         // 整次检索截止毫秒，默认 5000
  now?: () => number          // 时间源（毫秒），测试用
}
```

## 挂载

宿主先挂 `toy-embedding`、`toy-memory-fast`、`toy-memory-long`，再挂 `MemoryRead`：

```ts
import { Context } from "cordis"
import { EmbeddingRuntime } from "toy-embedding"
import { FastMemory } from "toy-memory-fast"
import { LongMemory } from "toy-memory-long"
import { MemoryRead } from "toy-memory-read"

const ctx = new Context()
await ctx.plugin(EmbeddingRuntime)
await ctx.plugin(FastMemory, { embeddingProvider: "dashscope", embeddingModel: "text-embedding-v3" })
await ctx.plugin(LongMemory)
await ctx.plugin(MemoryRead, { embeddingProvider: "dashscope", embeddingModel: "text-embedding-v3" })

const result = await ctx.memoryRead.search({
  scope: { userId: "u1", memorySpaceId: "space1" },
  query: "小明",
  mode: "weak",
})
```

挂载后通过 `ctx.memoryRead.search` 调用。

## 示例与测试

```sh
npm run example -w toy-memory-read
npm test -w toy-memory-read
```

示例使用内存 mock（Embedding/Fast/Long）演示弱/强检索编排；测试覆盖完整检索、Embedding 失败降级、分支失败隔离、重试、mode 透传与全失败三态。
