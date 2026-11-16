# toy-storage-vector

`toy-storage-vector` 定义数据库无关的向量存储协议。挂载 `VectorStorage` 后，业务和 adapter 可以通过 `ctx.storageVector` 声明集合、读取集合定义并校验操作。具体存储插件实现 `VectorAdapter`，就绪后以 `vector + name` 注册到 `ctx.storage`。

## 声明 Schema

```ts
import { Context } from "cordis"
import { VectorStorage } from "toy-storage-vector"

const ctx = new Context()
await ctx.plugin(VectorStorage)

const schema = ctx.storageVector.defineSchema({
  collections: {
    memories_v1: {
      dimensions: 3,
      metric: "cosine",
      filterFields: { userId: "string", category: "string" },
    },
  },
})
```

- Schema 至少包含一个集合。集合名和过滤字段名都遵循 `[A-Za-z_][A-Za-z0-9_]*`，`id`、`embedding` 和 `payload` 是保留字段名。
- `dimensions` 是正安全整数，实际值应与上游 embedding 模型的输出维度一致。写入和查询都使用同一维度的稠密数组，分量必须有限。当前度量是 `cosine`，向量必须至少包含一个非零分量。
- `filterFields` 可声明 `string`、`number` 或 `boolean`，其中数值必须有限。每条记录的 `fields` 必须完整提供声明过的字段。省略 `filterFields` 的集合使用 `fields: {}`。
- 记录的 `id` 是集合内唯一、由调用方分配的非空字符串。可选的 `payload` 是 JSON 对象，可包含嵌套对象、数组和 `null`。

Schema 描述逻辑约束，物理表、索引和数据库迁移由具体 adapter 管理。

## Cordis 服务

| 方法                                 | 行为                                                                                     |
| ------------------------------------ | ---------------------------------------------------------------------------------------- |
| `defineSchema(schema)`               | 校验并返回原对象，保留 TypeScript 字面量类型。通过校验后，调用方应把 Schema 视为只读配置 |
| `requireCollection(schema, name)`    | 读取已校验 Schema 中的集合定义，集合未知时抛出 `collection-not-found`                    |
| `assertOperation(schema, operation)` | 按集合约束校验操作。可在写操作入队前调用，adapter 也应在执行前调用                       |

## 操作与结果

每条操作都指定 `collection`。`VectorAdapter.execute()` 按操作类型推导结果，并接受可选的 `signal` 和 `timeoutMs`。`VectorAdapter.close()` 负责释放底层资源，可以重复调用。

| `type`       | 输入字段                           | 结果                                                                   |
| ------------ | ---------------------------------- | ---------------------------------------------------------------------- |
| `upsert`     | `value`，即完整 `VectorRecord`     | `{ id }`。同一 ID 的记录会整体替换，省略 `payload` 会清除旧值          |
| `upsertMany` | `values`，非空的完整记录数组       | `{ ids }`，顺序与输入一致。逐条沿用 `upsert` 语义，拒绝同批重复 ID     |
| `get`        | `id`                               | `{ record }`。命中时包含完整记录和向量，缺失时为 `undefined`           |
| `delete`     | `id`                               | `{ affectedRows }`。删除成功返回 `1`，记录已不存在时返回 `0`           |
| `deleteMany` | `ids`，非空的 ID 数组              | `{ affectedRows }`。返回实际删除数，重复或已不存在的 ID 不额外计数     |
| `search`     | `vector`、`limit` 和可选的 `where` | `{ matches }`。每项包含 `id`、`fields`、可选的 `payload` 和 `distance` |

批量操作针对一个集合，整个批次一起提交或回滚。

`search.limit` 必须是 `1–100` 的整数。`where` 支持单个 `eq`，也支持用非空的 `and.conditions` 同时匹配多个 `eq`。过滤字段及其值必须符合声明。adapter 先限定候选范围，再按距离从小到大返回最多 `limit` 条，同距离按 ID 升序排列。

具体 adapter 注册为 `vector/main` 后，业务可以这样调用。

```ts
import type { VectorAdapter } from "toy-storage-vector"
import "toy-storage"

const store = ctx.storage.get<VectorAdapter>("vector", "main")

await store.execute({
  type: "upsert",
  collection: "memories_v1",
  value: {
    id: "memory-42",
    vector: [0.2, 0.3, 0.4],
    fields: { userId: "u1", category: "preference" },
    payload: { text: "用户喜欢听故事" },
  },
})

const { matches } = await store.execute({
  type: "search",
  collection: "memories_v1",
  vector: [0.2, 0.3, 0.4],
  where: {
    type: "and",
    conditions: [
      { type: "eq", field: "userId", value: "u1" },
      { type: "eq", field: "category", value: "preference" },
    ],
  },
  limit: 10,
})
```

## 事务

支持事务的 adapter 提供 `transaction(callback, options?)`。通过回调内的 `tx.execute()`
组合多条向量操作。回调或其中的操作失败时回滚，回调返回值在确认提交后交给调用方。
执行器仅在当前回调期间可用。事务可配置 `isolation`、`readOnly`、`signal` 和 `timeoutMs`。

## 错误与写入队列

协议校验错误通过 `VectorError.code` 区分，包括 `invalid-schema`、`collection-not-found`、`invalid-field`、`invalid-value` 和 `invalid-operation`。

向量写操作可交给 `toy-storage-write-queue`。`VectorError` 提供队列识别的 `retryable` 和 `unknownState`。adapter 确认写入未提交时，可以用 `connection-failed` 或 `timeout` 表示可重试失败。提交结果无法确认时使用 `unknown-commit-state`，由队列保留任务等待核对。

## 示例与测试

从仓库根目录运行。示例展示如何声明集合并校验写入和多条件检索，运行时仅需 Cordis。

```sh
npm run example -w toy-storage-vector
npm run test -w toy-storage-vector
```

完整示例见 [examples/basic.mjs](examples/basic.mjs)，协议测试见 [test/vector.test.mjs](test/vector.test.mjs)。
