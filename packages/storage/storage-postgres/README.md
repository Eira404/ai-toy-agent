# toy-storage-postgres

一个命名 PostgreSQL 实例对应一个 Cordis 类插件 `PostgresStorage`。插件实现
`RelationalAdapter`，在连接成功后以 `relational + name` 注册到 `ctx.storage`。

`name` 标识数据库实例，不标识表或写入队列。同一个 PostgreSQL 数据库中的表应放在
同一次注册的 `schema.tables` 中；不同业务 writer 都通过同一个名称获取 adapter。
每次加载 `PostgresStorage` 都会创建并拥有一个连接池。即使两个实例使用相同的
`connectionString`，只要分别注册 `main`、`main1`，它们仍是两个连接池，不会自动合并。

## 连接配置

连接串放在仓库根目录的 `.env`，该文件已被 `.gitignore` 忽略。复制根目录
`.env.example` 并填入实际地址。用户名、密码不写入 YAML 或代码；YAML 如有使用，
只保存数据源名称、连接池大小等非敏感配置。这里使用 Node 的 `--env-file` 读取 `.env`。

从仓库根目录运行：

```sh
npm run check:connection -w toy-storage-postgres
npm run test:live -w toy-storage-postgres
npm run example -w toy-storage-postgres
```

`check:connection` 会显示数据库身份、服务端连接进程号和示例表记录，不修改数据。
实库测试会创建一个独立的临时 PostgreSQL schema，执行 CRUD 和事务验证后删除。
示例程序会在 `toy_storage_example.events` 写入数据，并打印 `sessionId` 以便查询。
完整示例见 [examples/basic.mjs](examples/basic.mjs)。

## 在代码中调用

```ts
import { Context } from "cordis"
import { ToyStorage } from "toy-storage"
import { RelationalStorage } from "toy-storage-relational"
import { PostgresStorage } from "toy-storage-postgres"

const ctx = new Context()
await ctx.plugin(ToyStorage)
await ctx.plugin(RelationalStorage)
await ctx.plugin(PostgresStorage, {
  name: "main",
  connectionString: process.env.DATABASE_URL!,
  createMissing: true,
  schema: {
    tables: {
      users: {
        primaryKey: "id",
        columns: {
          id: { type: "string" },
          name: { type: "string" },
        },
      },
    },
  },
})

const database = ctx.storage.get<import("toy-storage-relational").RelationalAdapter>(
  "relational",
  "main",
)
await database.execute({ type: "insert", table: "users", value: { id: "u1", name: "Alice" } })

const user = await database.execute({ type: "get", table: "users", key: "u1" })
console.log(user.row)

const users = await database.execute({
  type: "find",
  table: "users",
  where: { type: "eq", field: "name", value: "Alice" },
  limit: 20,
})
console.log(users.rows)
```

默认只连接和检查可达性。`createMissing: true` 会创建缺失的 schema、表和索引；
它不会修改已有列、删除结构或执行版本迁移。数据库本身及账号需要预先创建。
数据库驱动错误被转换成稳定的 `RelationalError`。

`AbortSignal` 会在事务开始前、每条查询前及提交前检查；已经在数据库服务器执行的
语句主要依靠 `timeoutMs` 对应的 PostgreSQL `statement_timeout` 中止。事务提交阶段
失联时返回 `unknown-commit-state`，调用方需要先核对结果再决定是否重试。
