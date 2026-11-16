# toy-memory-write

对话期 Fast 写入。把一次真实 Turn 的用户原话经 LLM 提取成 0..N 条记忆草稿并落库；也提供绕过 LLM 的直接写入入口。提取任务的输入快照、重试与终态由本包管理。

依赖 `toy-memory-fast`（`listRecentBySession` + `append`）与 `toy-llm`（`responseFormat: json_schema` 结构化提取）。

## 方法

| 方法 | 说明 |
|---|---|
| `extract(input, wait?)` | 读取同 Session 最近 Fast + 近期对话 → LLM 提取 → 校验 → `append` 落库 |
| `write(input)` | 直接写入 title/summary/body，绕过 LLM，立即落库 |

### `extract` 的等待级别

| `wait` | 返回时机 |
|---|---|
| `"started"` | 启动 LLM 提取后立即返回 `{ kind: "started" }`，后台继续落库 |
| `"written"`（默认） | 等待提取、校验、落库完成后返回终态 |

终态结果：

```ts
type FastExtractResult =
  | { kind: "started" }
  | { kind: "written"; writeId: string; records: readonly FastRecord[]; attempts: number }
  | { kind: "empty"; attempts: number }          // 无新增事实，未写入
  | { kind: "failed"; attempts: number; error: string }  // 重试耗尽
```

## 提取逻辑

```
extract
  ├─ 校验 + 冻结近期对话快照
  ├─ fast.listRecentBySession(scope, sessionId, recentSessionFastLimit)   ← 同 Session 最近 Fast
  ├─ 构造三段式 prompt（<USER_INPUT>/<RECENT_CONVERSATION>/<RECENT_FAST_MEMORY>）
  ├─ LLM 提取（responseFormat json_schema），失败重试 1 次（共 2 次）
  ├─ 校验：zod 结构 + 输出数量上限 + body 每行 `- ` 开头
  └─ 空数组 → empty；非空 → fast.append → written
```

重复投递同一 Turn 靠 `fast.append` 唯一索引幂等兜底，本包不额外去重。

## 配置

```ts
interface FastExtractConfig {
  llmProvider: string            // 必填
  llmModel: string               // 必填

  maxAttempts?: number           // 默认 2（含首次，即重试 1 次）
  recentConversationLimit?: number  // 默认 20
  recentSessionFastLimit?: number   // 默认 30
  maxMemoriesPerTurn?: number    // 默认 10
  maxTokens?: number
}
```

## 挂载

先挂 `toy-memory-fast` 和 `toy-llm`（含 LLM adapter），再挂本包：

```ts
import { Context } from "cordis"
import { ToyMemoryFast } from "toy-memory-fast"
import { LlmRuntime } from "toy-llm"
import { FastWrite } from "toy-memory-write"

const ctx = new Context()
await ctx.plugin(ToyMemoryFast, { embeddingProvider: "x", embeddingModel: "y" })
await ctx.plugin(LlmRuntime)
// 注册 LLM adapter（省略）
await ctx.plugin(FastWrite, { llmProvider: "chat", llmModel: "qwen-max" })
```

挂载后通过 `ctx.memoryWrite` 调用。

## 示例与测试

```sh
npm run example -w toy-memory-write
npm test -w toy-memory-write
```

示例与测试都用内存 mock 的 `memoryFast` / `llm`，不连真库、不调真实模型。
