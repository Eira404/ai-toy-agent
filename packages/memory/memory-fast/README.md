# toy-memory-fast

Fast 证据层。保存尚未完成长期整理的新增记忆，提供追加、近期读取、向量索引补写、双通道检索，以及 Daily 消费所需的数据与计划入口。

Fast 只追加、不修改；正文以关系表为准，向量命中后回表校验消费状态。它是 `toy-memory-write`（提取）、`toy-memory-read`（联合检索）与 `toy-memory-daily`（消费）共同依赖的数据拥有方。

## 数据模型

两张关系表 + 一个向量集合，由宿主合并到命名存储实例：

| 对象 | 职责 |
|---|---|
| `toy_memory_fast_records` | Fast 正文（title/title_key/summary/body）与来源、消费状态 |
| `toy_memory_fast_embedding_jobs` | 一次非空 Turn 写入的向量待办，兼作写入幂等凭据 |
| `toy_memory_fast_vectors` | `summary` 的语义向量，检索命中后回表 |

- `title_key` 由程序规范化（NFKC + 英文小写 + 首尾 trim），仅用于标题完全匹配，不暴露业务语义。
- `consumed_batch_id` 非空表示已被 Daily 成功消费，不再参与检索；冻结进 Daily 但未提交的 Fast 仍可检索。
- 向量记录 ID 使用 `fast_id`，正文不回写向量 `payload`。

## 方法

| 方法 | 说明 |
|---|---|
| `append(input)` | 程序分配 ID，同事务写主记录与待办；并发重试按唯一索引幂等返回已提交批次 |
| `listRecentBySession(scope, sessionId, limit)` | 该 Session 最近有效 Fast，供提取消歧（不等 Embedding） |
| `runEmbeddingJobs(options?)` | 认领待办、批量 Embedding、写向量；`append` 后台自动触发 |
| `search(input)` | 标题完全匹配 + summary 向量相似，按 `fast_id` 去重合并，标题命中优先 |
| `listPendingForDaily(scope)` | 该空间所有未消费 Fast，供 Daily 阶段一 |
| `listBySpace(input)` | 运维分页浏览一个空间的全部 Fast（含已消费），游标翻页，可选 `pendingOnly` 过滤 |
| `countBySpace(scope)` | 一次返回该空间的 `{ total, pending, consumed }` 计数 |
| `prepareConsumption(input)` | 生成本批消费计划（消费标记 + 向量删除 + 待办关闭），由 Daily 最终提交执行 |

## 配置

```ts
interface FastConfig {
  relationalSource?: string   // 关系型实例名，默认 "main"
  vectorSource?: string       // 向量实例名，默认 "main"
  embeddingProvider: string   // 必填，Embedding 路由名
  embeddingModel: string      // 必填，Embedding 模型名

  maxTitleLength?: number     // 80
  maxSummaryLength?: number   // 300
  maxBodyLength?: number      // 4000

  minVectorScore?: number     // 0.3（1 - cosine distance）
  minVectorCount?: number     // 1
  maxVectorCount?: number     // 10

  batchSize?: number          // 50
  leaseMs?: number            // 120000
  maxAttempts?: number        // 5
  backoffBaseMs?: number      // 2000
  backoffJitter?: boolean     // true

  now?: () => string          // 时间源注入，测试用
}
```

## 挂载

宿主先挂命名存储与适配器（PostgreSQL + pgvector），再挂 `FastMemory`：

```ts
import { Context } from "cordis"
import { ToyStorage } from "toy-storage"
import { RelationalStorage } from "toy-storage-relational"
import { VectorStorage } from "toy-storage-vector"
import { PostgresStorage } from "toy-storage-postgres"
import { PgvectorStorage } from "toy-storage-pgvector"
import { EmbeddingRuntime } from "toy-embedding"
import { FastMemory, fastRelationalSchema, defineFastVectorSchema } from "toy-memory-fast"

const ctx = new Context()
await ctx.plugin(ToyStorage)
await ctx.plugin(RelationalStorage)
await ctx.plugin(VectorStorage)
await ctx.plugin(PostgresStorage, {
  name: "main",
  connectionString: process.env.DATABASE_URL!,
  createMissing: true,
  // 宿主合并各业务包的关系表
  schema: fastRelationalSchema,
})
await ctx.plugin(PgvectorStorage, {
  name: "main",
  connectionString: process.env.DATABASE_URL!,
  createMissing: true,
  schema: defineFastVectorSchema(1024), // 维度与 embedding 模型一致
})
await ctx.plugin(EmbeddingRuntime)
// 宿主按需注册 embedding adapter（此处省略）

await ctx.plugin(FastMemory, {
  embeddingProvider: "dashscope",
  embeddingModel: "text-embedding-v3",
})
```

挂载后通过 `ctx.memoryFast` 调用。`append` 成功后会 fire-and-forget 触发一次 `runEmbeddingJobs`，宿主无需额外调度。

## 事务边界

v4 的 relational 与 vector 是两个独立 adapter，无法跨源联合事务。消费执行拆两段：

1. **relational 事务**：写 `consumed_batch_id/consumed_at`、关闭未完成待办（与 Daily 的 Long/反馈变更同处一个关系事务）。
2. **事务提交后**：`vector.deleteMany` 幂等清理。

先标关系消费即可让记录立刻退出检索（回表校验 `consumed_batch_id IS NULL`），向量残留只浪费存储、不影响正确性。

## 示例与测试

```sh
npm run example -w toy-memory-fast
npm test -w toy-memory-fast
```

示例使用内存 mock 演示完整链路（不连真库）；测试同样用内存关系型/向量/Embedding 实现覆盖追加、检索、补写与消费计划。
