# toy-storage-relational

`toy-storage-relational` 定义数据库无关的关系型存储协议。它负责逻辑 Schema、条件表达式、
CRUD 操作、批处理、事务、统一结果、稳定错误以及 write-back 所需的操作特征。

本包是 Cordis 类插件，运行时依赖 Cordis；不连接数据库、不生成 SQL、不保存数据。
内存实现和 MySQL、PostgreSQL 等 adapter 应共同实现本包导出的 `RelationalAdapter`。
安装 `RelationalStorage` 后，可使用 `ctx.storageRelational.defineSchema()`、
`assertOperation()`、`operationTraits()` 等服务方法。纯函数作为包内部实现细节。

```ts
import { Context } from "cordis"
import { RelationalStorage } from "toy-storage-relational"

const ctx = new Context()
await ctx.plugin(RelationalStorage)
const schema = ctx.storageRelational.defineSchema({
  tables: {
    users: {
      primaryKey: "id",
      columns: { id: { type: "string" } },
    },
  },
})
```

## 定义 Schema

```ts
import { Context } from "cordis"
import { RelationalStorage } from "toy-storage-relational"

const ctx = new Context()
await ctx.plugin(RelationalStorage)

const schema = ctx.storageRelational.defineSchema({
  tables: {
    users: {
      primaryKey: "id",
      columns: {
        id: { type: "string" },
        name: { type: "string" },
        age: { type: "integer", nullable: true },
        createdAt: { type: "datetime" },
      },
      indexes: [{ name: "users_created_at", fields: ["createdAt"] }],
    },
  },
})
```

Schema 只描述逻辑结构，不代表数据库迁移。本包不会自动执行 `CREATE TABLE`。

## 构造并校验操作

```ts
const operation = {
  type: "find",
  table: "users",
  where: { type: "gte", field: "age", value: 18 },
  orderBy: [{ field: "createdAt", direction: "desc" }],
  limit: 20,
} as const

ctx.storageRelational.assertOperation(schema, operation)
```

adapter 必须把标识符校验、参数化语句、驱动错误转换等工作放在自己的实现中；业务调用方
不得把原生 SQL 作为操作传入。

## 当前边界

- 支持 `get`、`find`、`count`、`insert`、`insertMany`、`upsert`、`update` 和 `delete`。
- 支持比较、集合、空值、`like` 以及 `and` / `or` / `not` 条件。
- 支持排序、分页、批处理和单数据源事务契约。
- 不支持 join、聚合、原生 SQL、数据库迁移和跨数据源事务。
