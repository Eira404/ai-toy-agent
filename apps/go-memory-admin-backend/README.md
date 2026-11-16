# toy-go-memory-admin-backend

Go 记忆系统的管理员后端启动入口（应用，非库）。复用 Go 记忆后端同一个 PostgreSQL，
挂载 `toy-admin-auth` + `toy-admin` + `toy-admin-backend` + `toy-memory-go-admin`，
通过 `/admin` 前缀暴露账号端点与记忆运维能力。

只读运维后端：不接 daily / feedback / scheduler 写入路径，也不接 LLM / Embedding 适配器。

## 启动

```bash
npm run build
# 首次启动：在 .env 里设置 ADMIN_BOOTSTRAP_PASSWORD 创建首个 superadmin
npm start
```

## 环境变量（.env）

| 变量 | 说明 | 默认 |
| --- | --- | --- |
| `DATABASE_URL` | PostgreSQL 连接串（复用 Go 后端库） | 必填 |
| `DB_SCHEMA` | PostgreSQL schema 名 | public |
| `HOST` / `PORT` | 监听地址 | `127.0.0.1` / `3200` |
| `ADMIN_MOUNT_PATH` | admin 挂载前缀 | `/admin` |
| `ADMIN_BOOTSTRAP_LOGIN` | 首个 superadmin 登录名 | `admin` |
| `ADMIN_BOOTSTRAP_PASSWORD` | 首个 superadmin 密码（首次启动必填） | 空=跳过 |

## 接口

账号端点（由 `toy-admin-backend` 提供）：`POST /admin/login`、`GET /admin/me` 等。

记忆运维能力（由 `toy-memory-go-admin` 注册）：

| 能力 | HTTP |
| --- | --- |
| `memory.admin.list-users` | `GET /admin/memory/users` |
| `memory.admin.list-user-overview` | `GET /admin/memory/user-overview?userId=...` |
| `memory.admin.list-fast` | `GET /admin/memory/fast?memorySpaceId=...` |
| `memory.admin.get-fast` | `GET /admin/memory/fast-detail?memorySpaceId=...&fastId=...` |
| `memory.admin.list-long` | `GET /admin/memory/long?memorySpaceId=...` |
| `memory.admin.get-long` | `GET /admin/memory/long-detail?memorySpaceId=...&blockId=...` |

调用时带 `Authorization: Bearer <token>`，token 由 `POST /admin/login` 获取。
