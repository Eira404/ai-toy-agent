# toy-memory-go-backend

> **[TEMP]** 临时包，仅供 Go conversation 服务调用，不是 v4 在线 Agent 的路径。
> 与 `toy-memory-tools` / `toy-memory-lifecycle` 无关，后续 Go 迁移完成即可废弃。

记忆读写 HTTP 门面：把 Go 的 `POST /memory/read` 与 `POST /memory/write` 映射到
`toy-memory-read` / `toy-memory-write`。请求里不携带 `memorySpaceId`，门面按
`userId + deviceId` 用 `toy-memory-space` 的 `resolveOrCreateMemorySpace` 解析或创建；
新建空间时自动挂一份 daily 调度。

## 链路

```
Go conversation
  ↓ HTTP
POST /memory/read   { context:{userId,deviceId,sessionId,turnId}, query, mode? }
POST /memory/write  { context:{...}, memories:[{title,summary,body}] }
  ↓ MemoryGoBackend
  ├─ memorySpace.resolveOrCreateMemorySpace(userId, deviceId)
  │     └─ 新建时 → memoryScheduler.setDailySchedule(03:00, Asia/Shanghai, 10)
  ├─ memoryRead.search({ scope, query, mode })   → 精简正文
  └─ memoryWrite.write({ scope, sessionId, turnId, drafts })
```

## HTTP 接口

| 方法 | 路由 | 输入 | 输出（envelope `data`） |
|---|---|---|---|
| POST | `/memory/read` | `context`、`query`、`mode?` | `{ status, fast, long }` |
| POST | `/memory/write` | `context`、`memories` | `{ kind, writeId, records }` |

- `context = { userId, deviceId, sessionId, turnId }`，四字段均必填。
- `mode` 省略默认 `weak`；`strong` 原样透传给 Long。
- `memories` 每条 `{ title, summary, body }`，body 为 Markdown 无序列表。
- 成功 envelope 为 `{ ok: true, data }`，失败为 `{ ok: false, error: { code, message } }`
  （由 `toy-backend-http` 生成）。

### 读结果

```json
{
  "status": "COMPLETE | PARTIAL | UNAVAILABLE",
  "fast": [{ "title": "...", "summary": "...", "body": "..." }],
  "long": [{ "title": "...", "summary": "...", "overviewBody": "...", "details": [{ "summary": "...", "body": "..." }] }]
}
```

### 写结果

```json
{ "kind": "written", "writeId": "...", "records": [{ "title": "...", "summary": "...", "body": "..." }] }
```

## 服务方法

| 方法 | 说明 |
|---|---|
| `readMemory(input)` | 解析/创建空间 → `memoryRead.search` → 精简正文 |
| `writeMemory(input)` | 解析/创建空间 → `memoryWrite.write` → 投影 records |

## 配置

```ts
interface GoBackendConfig {
  dailyAt?: string       // 默认 "03:00"
  timeZone?: string      // 默认 "Asia/Shanghai"
  minPendingFast?: number // 默认 10
}
```

新建空间时自动用这三个默认值调用 `memoryScheduler.setDailySchedule`。

## 挂载

宿主需先挂 `toy-backend-http`（`http`）、`toy-memory-space`、`toy-memory-read`、
`toy-memory-write`、`toy-memory-scheduler`，再挂 `MemoryGoBackend`：

```ts
import { Context } from "cordis"
import { HttpServer } from "toy-backend-http"
import { MemorySpaceService } from "toy-memory-space"
import { MemoryRead } from "toy-memory-read"
import { FastWrite } from "toy-memory-write"
import { MemoryScheduler } from "toy-memory-scheduler"
import { MemoryGoBackend } from "toy-memory-go-backend"

const ctx = new Context()
await ctx.plugin(HttpServer, { port: 3000 })
await ctx.plugin(MemorySpaceService)
await ctx.plugin(MemoryRead, { embeddingProvider: "...", embeddingModel: "..." })
await ctx.plugin(FastWrite, { llmProvider: "...", llmModel: "..." })
await ctx.plugin(MemoryScheduler)
await ctx.plugin(MemoryGoBackend, { dailyAt: "03:00", timeZone: "Asia/Shanghai", minPendingFast: 10 })
```

> `toy-memory-scheduler` 必须被挂载，否则 `MemoryGoBackend` 的 inject 缺失会初始化失败。

## 示例与测试

```sh
npm run example -w toy-memory-go-backend
npm test -w toy-memory-go-backend
```

示例与测试使用内存 mock（memorySpace / memoryRead / memoryWrite / memoryScheduler），
不连真库、不调真实模型；HTTP 路由通过真实 `toy-backend-http` 监听临时端口验证。
