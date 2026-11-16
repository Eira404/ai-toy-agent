# toy-storage-pgvector

`PgvectorStorage` 是 `toy-storage-vector` 的 PostgreSQL 实现。每次挂载对应一个连接池。扩展和集合检查成功后，实例以 `vector + name` 注册到 `ctx.storage`。插件卸载时撤销注册，并关闭由该实例拥有的连接池。

## 数据库准备

由部署或迁移账号在目标数据库启用 [pgvector 扩展](https://github.com/pgvector/pgvector#getting-started)。

```sql
CREATE EXTENSION IF NOT EXISTS vector;
```

将连接串写入仓库根目录的 `.env`，变量名为 `DATABASE_URL`，格式见根目录的 `.env.example`。扩展和数据表可以位于不同的 PostgreSQL schema，adapter 会使用扩展的实际安装位置。

## 挂载和调用

```ts
import { Context } from "cordis"
import { ToyStorage } from "toy-storage"
import { PgvectorStorage } from "toy-storage-pgvector"
import { VectorStorage, type VectorAdapter } from "toy-storage-vector"

const ctx = new Context()
await ctx.plugin(ToyStorage)
await ctx.plugin(VectorStorage)
await ctx.plugin(PgvectorStorage, {
  name: "main",
  connectionString: process.env.DATABASE_URL!,
  schemaName: "app_vectors",
  createMissing: true,
  schema: {
    collections: {
      memories: {
        dimensions: 3,
        metric: "cosine",
        filterFields: { userId: "string", category: "string" },
      },
    },
  },
})

const store = ctx.storage.get<VectorAdapter>("vector", "main")
await store.execute({
  type: "upsert",
  collection: "memories",
  value: {
    id: "memory-42",
    vector: [1, 0, 0],
    fields: { userId: "u1", category: "preference" },
    payload: { text: "用户喜欢听故事" },
  },
})

const { matches } = await store.execute({
  type: "search",
  collection: "memories",
  vector: [1, 1, 0],
  where: {
    type: "and",
    conditions: [
      { type: "eq", field: "userId", value: "u1" },
      { type: "eq", field: "category", value: "preference" },
    ],
  },
  limit: 5,
})
```

`get` 和 `delete` 用 `collection` 与 `id` 定位记录。每次 `upsert` 会整体替换同 ID 的记录，省略 `payload` 会清除原值。检索在数据库中应用过滤条件，对候选记录计算精确余弦距离，再按距离和 ID 升序取 Top K。写入和查询使用同一 embedding 模型，向量分量按 pgvector 的单精度格式处理。

## 配置和表结构

| 配置                                                     | 含义                                                                           |
| -------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `name`                                                   | 向量存储实例名，业务通过 `ctx.storage.get("vector", name)` 查找                |
| `connectionString`                                       | PostgreSQL 连接串                                                              |
| `schema`                                                 | 向量逻辑集合定义                                                               |
| `schemaName`                                             | 集合表所在的 PostgreSQL schema，默认 `public`                                  |
| `createMissing`                                          | 默认 `false`，只检查数据库结构。设为 `true` 时以单个事务创建缺失的 schema 和表 |
| `maxConnections`、`connectionTimeoutMs`、`idleTimeoutMs` | 默认分别为 10、5000 和 30000                                                   |
| `pool`                                                   | 可注入已有连接池，插件接管其所有权                                             |

每个集合对应一张表。启动会检查 `id` 文本主键、`embedding vector(n) NOT NULL`、可空的 `payload JSONB` 和声明过的非空过滤列。表结构演进和过滤列索引通过显式迁移管理。

独立执行的操作使用单连接事务，写操作确认提交后才返回成功。`upsertMany` 使用多行
`INSERT ... ON CONFLICT`，大批次在同一个事务中分块。`deleteMany` 使用一条绑定 ID 数组的
`DELETE`。需要将多个操作一起提交时，可以使用事务回调。

```ts
const store = ctx.storage.get<PgvectorStorage>("vector", "main")
await store.transaction(async (tx) => {
  await tx.execute({ type: "upsertMany", collection: "memories", values: newRecords })
  await tx.execute({ type: "deleteMany", collection: "memories", ids: obsoleteIds })
})
```

提交阶段失联返回 `unknown-commit-state`，现有写入队列会保留任务等待核对。`timeoutMs` 对应 PostgreSQL `statement_timeout`。`AbortSignal` 在拿连接前后、执行前及提交前检查，已在服务端运行的语句由数据库超时中止。

## 测试和示例

先从仓库根目录构建 workspace。单元测试使用模拟连接池。实库测试和示例会各自创建并清理独立的临时 schema，需要数据库用户有创建 schema 的权限。

```sh
npm run build
npm test -w toy-storage-pgvector
npm run test:live -w toy-storage-pgvector
npm run example -w toy-storage-pgvector
```

完整示例见 [examples/basic.mjs](examples/basic.mjs)，实库测试见 [test/live.mjs](test/live.mjs)。
