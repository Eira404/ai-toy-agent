# toy-debug-user

仅供 debug 使用的「用户」表定义及创建方法，作为 Cordis 类插件挂载到 `ctx.debugUsers`。生产环境的用户数据由其他系统维护，本包不参与鉴权。

## 职责

- 导出 `usersRelationalSchema`，定义 `toy_users` 表。
- 通过名称调用已连接的关系型 adapter，提供 `createUser` / `ensureUser` / `seedUsers` / `getUser` / `listUsers` / `updateUser` / `deleteUser`。
- 所有写入同步落库，不依赖写入队列。

## 注册

```js
import { DebugUsers, usersRelationalSchema } from "toy-debug-user"

await ctx.plugin(PostgresStorage, {
  name: "main",
  connectionString,
  createMissing: true,
  schema: { tables: { ...usersRelationalSchema.tables } },
})
await ctx.plugin(DebugUsers, { sourceName: "main" })
```

## 表结构

`toy_users`：`user_id`（主键）、`display_name`、`note`、`payload`（json）、`created_at`、`updated_at`。
