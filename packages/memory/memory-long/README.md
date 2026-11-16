# toy-memory-long

Long 长期认知层。存储由 Daily Dream 整理出的记忆块（Domain + title/aliases + summary + 当下概括 + 细节补充），提供弱/强检索、只读查询，以及 Daily/Weekly 所需的快照冻结与变更应用入口。

Long 只能由 Dream 修改，Fast 只能先进入 Fast 再由 Daily 整理成 Long。记忆价值与自然遗忘只作用于 Long；价值状态由**价值遗忘系统**以 `version + opaque JSON` 封装，记忆系统只消费 `lifecycleStatus`。

## 数据模型

四张关系表 + 一个向量集合，由宿主合并到命名存储实例：

| 对象 | 职责 |
|---|---|
| `toy_memory_long_blocks` | 记忆块主表：Domain、title/aliases、summary、当下概括正文与价值状态 |
| `toy_memory_long_details` | 细节补充：每条是独立价值单元，`detail_id` 即单元 ID |
| `toy_memory_long_aliases` | 别名，供 title/alias 规范化完全匹配 |
| `toy_memory_long_keywords` | 预留结构，MVP 不生成、不检索 |
| `toy_memory_long_vectors` | 块 summary 与细节 summary 平级存放的语义向量 |

- `title_key` / `alias_key` 由程序规范化（NFKC + 英文小写 + 首尾 trim），仅用于完全匹配。
- 价值状态封装为 `value_version`（版本）+ `value_state`（opaque JSON，含当前价值、遗忘时间、I/S/P/A 等），`lifecycle_status`（`active`/`observing`/`archived`）是价值遗忘系统返回的唯一公开状态。
- 向量记录 ID 用 `block:{blockId}` / `detail:{detailId}` 前缀区分；归档即删向量，关系表保留 archived 行供运维查看。

## 方法

| 方法 | 说明 |
|---|---|
| `searchWeak(input)` | 弱检索：title/alias 完全匹配 + 块 summary 向量，命中块内再做细节向量检索 |
| `searchStrong(input)` | 强检索：块 summary 与细节 summary 平级向量，命中细节带回父块概括 |
| `listBySpace(input)` | 运维分页浏览空间内块（含归档），支持 `domain`/`lifecycle` 过滤与 `orderBy` 排序 |
| `getBlock(scope, blockId)` | 读完整块（含别名与全部细节，含 archived） |
| `countBlocks(scope, options?)` | 统计块数量（可选 `domain`/`lifecycle` 过滤，默认含归档） |
| `countBlocksByDomain(scope, options?)` | 按 Domain 分组统计块数量（返回 6 项完整计数，含 0） |
| `listBlocksByDomain(scope, domain)` | 某 Domain 全部有效块摘要，供 Daily 阶段三召回 |
| `recallBySummary(scope, domain, vector, topK)` | summary 向量召回候选块 |
| `freezeSnapshot(scope)` | 冻结当前全部有效 Long（含细节与价值状态），供 Daily 阶段六/七 |
| `applyChanges(scope, changeSet, options?)` | 原子应用显式 CREATE/UPDATE/ARCHIVE 变更并维护向量索引 |

### 检索语义

- 弱检索两段式：第一层选块（title/alias 完全匹配 + 块 summary 向量），第二层在命中块内检索细节 summary。完全匹配块排最前。
- 强检索平级：全部块 summary 与细节 summary 一起向量检索。命中块 summary 时块 `reason = BLOCK_VECTOR`；只有细节命中时块 `reason = PARENT_CONTEXT` 并随附完整概括；`blockScore = max(块分, 各细节分)`。
- `queryVector` 为 `null` 或向量实例缺失时只走 title/alias 路。`status` 三态：`COMPLETE` / `PARTIAL` / `UNAVAILABLE`，由 `toy-memory-read` 与 Fast 结果汇总。

### 变更模型

`applyChanges` 使用显式三态（对齐 v1 stage-6 的 `CommitPlan`）：

- `CREATE`：新建块（细节只能 `CREATE`）。
- `UPDATE`：携带 `oldContent`/`oldValue` 与新内容；细节可 `CREATE`/`UPDATE`/`ARCHIVE`；old 与库中不一致时抛 `conflict`。
- `ARCHIVE`：整块归档，连带全部细节。

`summaryVector` 是调用方准备好的 summary Embedding；Long 不生成向量，只负责写入/删除索引。

## 配置

```ts
interface LongConfig {
  relationalSource?: string   // 关系型实例名，默认 "main"
  vectorSource?: string       // 向量实例名，默认 "main"；缺失时检索降级

  blockVectorThreshold?: number   // 0.3
  blockMinResults?: number        // 3
  blockMaxResults?: number        // 10
  detailVectorThreshold?: number  // 0.3
  detailMinPerBlock?: number      // 1
  detailMaxPerBlock?: number      // 5
  strongVectorThreshold?: number  // 0.3
  strongMinResults?: number       // 3
  strongMaxResults?: number       // 10

  overviewBodyTarget?: number  // 300
  overviewBodyHard?: number    // 400
  detailBodyTarget?: number    // 300
  detailBodyHard?: number      // 400
  blockTitleTarget?: number    // 30
  blockTitleHard?: number      // 40
  blockSummaryTarget?: number  // 80
  blockSummaryHard?: number    // 120
  detailSummaryTarget?: number // 40
  detailSummaryHard?: number   // 60

  now?: () => string           // 时间源注入，测试用
}
```

## 挂载

宿主先挂命名存储与适配器（PostgreSQL + pgvector），再挂 `LongMemory`：

```ts
import { Context } from "cordis"
import { ToyStorage } from "toy-storage"
import { RelationalStorage } from "toy-storage-relational"
import { VectorStorage } from "toy-storage-vector"
import { PostgresStorage } from "toy-storage-postgres"
import { PgvectorStorage } from "toy-storage-pgvector"
import { LongMemory, longRelationalSchema, defineLongVectorSchema } from "toy-memory-long"

const ctx = new Context()
await ctx.plugin(ToyStorage)
await ctx.plugin(RelationalStorage)
await ctx.plugin(VectorStorage)
await ctx.plugin(PostgresStorage, {
  name: "main",
  connectionString: process.env.DATABASE_URL!,
  createMissing: true,
  // 宿主合并各业务包的关系表
  schema: longRelationalSchema,
})
await ctx.plugin(PgvectorStorage, {
  name: "main",
  connectionString: process.env.DATABASE_URL!,
  createMissing: true,
  schema: defineLongVectorSchema(1024), // 维度与 embedding 模型一致
})

await ctx.plugin(LongMemory)
```

挂载后通过 `ctx.memoryLong` 调用。

## 事务边界

v4 的 relational 与 vector 是两个独立 adapter，无法跨源联合事务。`applyChanges` 拆两段：

1. **relational 事务**：块/细节/别名的 insert/upsert/update/delete 原子提交，同时收集需要变更的向量操作。
2. **事务提交后**：`vector.deleteMany`（归档项）→ `vector.upsertMany`（新建/更新项）幂等执行。

先落关系表即可让归档块立刻退出检索（关系表按 `lifecycle_status` 过滤），向量残留只浪费存储、不影响正确性。跨两者的最终原子性由 Daily 层（阶段八）通过 `idempotencyKey` 与整体重试保证；`applyChanges` 的 `idempotencyKey` 提供进程内幂等。

## 示例与测试

```sh
npm run example -w toy-memory-long
npm test -w toy-memory-long
```

示例使用内存 mock 演示创建块、弱/强检索、快照冻结与归档（不连真库）；测试用内存关系型/向量实现覆盖检索、变更、冲突校验、归档与跨空间隔离。
