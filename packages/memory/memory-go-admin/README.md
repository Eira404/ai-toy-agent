# toy-memory-go-admin

面向 Go 记忆系统的运维管理插件（Cordis）。通过 `toy-admin` 注册一组**只读**管理能力，
让管理员 HTTP 后端（`toy-admin-backend`）按「用户 / 记忆空间」浏览 Fast 与 Long 记忆。

本包只读不写，不接 Session / 工具链；正文级能力默认不授予 viewer。

## 装配前提

- 已挂载 `toy-admin`（含审计存储）、`toy-memory-space`、`toy-memory-fast`、`toy-memory-long`。
- 由 `toy-admin-backend` 把能力挂成 HTTP 路由（默认前缀 `/admin`）。

> 「用户读取」（`list-users` / `list-user-overview`）是临时/测试实现：本后端没有
> 真正的用户表，userId 只能从 `toy_memory_spaces.user_id` 推导。这部分直接落在
> 本包内读关系表，不污染 `toy-memory-space`；真正的用户读取应由专门的用户包提供。
> 因此本包需要关系型实例（配置 `relationalSource`，默认 `main`）。

## 注册的能力

| 能力名 | HTTP | 说明 |
| --- | --- | --- |
| `memory.admin.list-users` | `GET /memory/users` | 列出已出现的 userId（去重、分页） |
| `memory.admin.list-user-overview` | `GET /memory/user-overview` | 某 userId 下的娃娃与记忆空间 |
| `memory.admin.list-fast` | `GET /memory/fast` | 按空间分页列 Fast（含计数） |
| `memory.admin.get-fast` | `GET /memory/fast-detail` | 单条 Fast 详情 |
| `memory.admin.list-long` | `GET /memory/long` | 按空间分页列 Long 块（可过滤） |
| `memory.admin.get-long` | `GET /memory/long-detail` | 单条 Long 块详情（含细节） |

- 元信息能力（users / user-overview）：`viewer` + `admin` + `superadmin`。
- 正文能力（fast / long）：`admin` + `superadmin`（PII）。

所有输入走 GET query 串（`toy-admin-backend` 对能力的路由不传 URL 路径参数）：
数字/布尔参数以字符串到达，由 execute 内部转换。分页游标为成对字段，例如
`beforeCreatedAt` + `beforeFastId`、`beforeSortAt` + `beforeBlockId`。

## 使用

```ts
import { MemoryGoAdmin } from "toy-memory-go-admin"

await ctx.plugin(MemoryGoAdmin, { relationalSource: "main" })
```

注册生命周期跟随 `ctx.effect`：插件卸载时自动注销全部能力。
