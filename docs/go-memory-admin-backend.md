# Go 记忆管理员后端使用说明

## 1. 定位与功能

应用目录：`apps/go-memory-admin-backend`。npm workspace 名：`toy-go-memory-admin-backend`。

这是记忆系统的管理员 HTTP API，供管理端查询用户、设备绑定、记忆空间和记忆内容，并执行手动 Daily 整理。它是 Node.js 应用，名称中的 Go 表示服务于 Go 业务系统。

当前功能包括：

- 管理员登录、退出、修改密码、会话撤销和账号管理。
- 查询已有用户、用户下的设备与记忆空间。
- 分页查看 Fast 证据、Long 长期记忆及其正文和细节。
- superadmin 手动触发指定空间的 Daily，并查询批次状态。
- 按角色授权记忆运维能力，并记录能力调用审计。

该应用已经装配 LLM、Embedding、JEV 和 Daily，**不是只读后端**。手动 Daily 会调用模型并写入记忆数据。应用自身不启动定时调度器，也不提供 Go conversation 的 `/memory/read`、`/memory/write` 门面。

## 2. 与另外两个后端的关系

| 应用                        | 职责                         | 数据关系                                        |
| --------------------------- | ---------------------------- | ----------------------------------------------- |
| `go-memory-service-backend` | 业务记忆读写与定时 Daily     | 管理员后端应连接它使用的同一数据库、同一 schema |
| `go-memory-admin-backend`   | 管理员认证、浏览和手动 Daily | 额外创建管理员账号、会话和审计相关表            |
| `memory-eval-backend`       | 离线批量评测                 | 评测记忆放在独立的 `memory_eval` schema         |

管理员后端直接访问数据库，不通过业务后端转发请求。因此可独立启动；但数据库地址或 schema 不一致时，将看不到业务后端写入的记忆。

## 3. 启动前准备

1. 安装 Node.js 和 npm。应用声明 Node.js `>=20.19.0`；三个后端统一运行时可使用 Node.js 24.x。
2. 准备 PostgreSQL，并在目标数据库安装 `vector` 扩展。
3. 准备 LLM Responses API、Embedding API，以及 JEV 的地址、密钥和模型权限。**生产环境 JEV 必填**。
4. 数据库账号需要目标 schema 下的建表和读写权限。应用会创建缺失的关系表与向量集合，但不会自动安装 PostgreSQL 的 `vector` 扩展。

数据库管理员可在目标数据库执行：

```sql
CREATE EXTENSION IF NOT EXISTS vector;
```

## 4. 配置

结构和模型路由在 [config.yaml](../apps/go-memory-admin-backend/config.yaml)，环境变量模板在 [.env.example](../apps/go-memory-admin-backend/.env.example)。

- `npm start` 使用 `node --env-file=.env lib/index.js`，读取应用工作目录下的 `.env`。
- YAML 中 `${VAR}` 引用环境变量，`${VAR:-默认值}` 支持默认值。
- `CONFIG_FILE` 可指定另一份 YAML；相对路径以进程工作目录为基准，建议使用绝对路径。
- 操作系统已有环境变量优先于 `.env`。修改配置后需重启进程。

| 环境变量                       | 用途与注意事项                                              |
| ------------------------------ | ----------------------------------------------------------- |
| `DATABASE_URL`                 | 必填；与业务记忆后端连接同一数据库                          |
| `DB_SCHEMA`                    | 默认 `public`；必须与业务后端一致，例如双方都用 `go_memory` |
| `HOST` / `PORT`                | 默认 `127.0.0.1` / `3200`                                   |
| `ADMIN_MOUNT_PATH`             | 默认 `/admin`；修改后所有管理员 API 前缀随之改变            |
| `ADMIN_BOOTSTRAP_LOGIN`        | 首个 superadmin 登录名，默认 `admin`                        |
| `ADMIN_BOOTSTRAP_PASSWORD`     | 首次初始化必填，新密码为 12–128 个字符；后续启动可移除      |
| `DASHSCOPE_RESPONSES_BASE_URL` | 必填；LLM Responses API 根地址或完整 `/responses` 地址      |
| `DASHSCOPE_API_KEY`            | 必填；模板中 LLM 和 Embedding 共用此密钥                    |
| `DASHSCOPE_EMBEDDING_BASE_URL` | 必填；Embedding API 根地址或完整 `/embeddings` 地址         |
| `EMBEDDING_DIMENSIONS`         | 默认 `1024`；须与业务后端、模型输出和已建向量列一致         |
| `JEV_BASE_URL` / `JEV_API_KEY` | 生产必填；TypeSafe JEV 服务地址和密钥                       |

模型名称在 YAML 的链条目中设置，不能仅通过设置 `LLM_MODEL` 或 `JEV_MODEL` 来改变本应用使用的模型：

| YAML 配置                                  | 作用                                                   |
| ------------------------------------------ | ------------------------------------------------------ |
| `llm.adapters` / `llm.chains`              | 声明 LLM 连接和有序降级候选；模板中 Daily 链为 `daily` |
| `embedding.adapters` / `embedding.chains`  | 声明 Embedding 连接和候选；模板链为 `embed`            |
| `jev.adapters` / `jev.chains`              | 声明 JEV 连接与模型候选；模板链为 `main`               |
| `memory.daily.llm` / `.embedding` / `.jev` | 分别指向上面三个类别中的链名                           |

链条目必须包含 `provider` 和 `model`。`provider` 指向 adapter 名称，`memory.daily.*` 指向链名。管理员应用当前只装配 `type: typesafe` 的 JEV adapter，不能直接套用业务后端的 `type: llm` JEV adapter。

保留并正确填写 `jev` 配置；模板里 JEV 地址和密钥为空，直接复制 `.env.example` 后启动会校验失败。

## 5. 启动步骤

以下 PowerShell 命令从仓库根目录执行。首次安装或依赖包源码变化后，先构建整个 workspace，保证各 `toy-*` 包的 `lib` 已生成：

```powershell
cd D:\code\node\ai-toy-agent-v4
npm install
npm run build

if (-not (Test-Path apps/go-memory-admin-backend/.env)) {
  Copy-Item apps/go-memory-admin-backend/.env.example apps/go-memory-admin-backend/.env
}
```

编辑应用 `.env`，填入数据库、三类模型服务信息和首次管理员密码，再检查 YAML 中的模型名和链映射。然后启动：

```powershell
npm run start -w toy-go-memory-admin-backend
```

也可以进入应用目录运行 `npm start`。如果只修改了本应用的 TypeScript 源码，启动前执行 `npm run build -w toy-go-memory-admin-backend`；如果修改了依赖包，也要重新构建相应依赖。

默认地址：`http://127.0.0.1:3200`。应用不附带管理员网页，访问根路径不能作为启动检查。日志应显示管理员路由挂载信息。

## 6. 登录与常用接口

默认前缀为 `/admin`。可用以下 PowerShell 命令验证登录和身份查询；密码使用刚才设置的实际密码：

```powershell
$baseUrl = 'http://127.0.0.1:3200'
$loginBody = @{ loginName = 'admin'; password = '替换为实际管理员密码' } | ConvertTo-Json
$login = Invoke-RestMethod -Method Post -Uri "$baseUrl/admin/login" -ContentType 'application/json' -Body $loginBody
$headers = @{ Authorization = "Bearer $($login.data.token)" }
Invoke-RestMethod -Uri "$baseUrl/admin/me" -Headers $headers
Invoke-RestMethod -Uri "$baseUrl/admin/memory/users" -Headers $headers
```

| 方法与路径                                                    | 用途与权限                                                             |
| ------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `POST /admin/login`                                           | 获取登录 token                                                         |
| `GET /admin/me`                                               | 查询当前登录身份                                                       |
| `GET /admin/memory/users`                                     | 用户列表；viewer、admin、superadmin                                    |
| `GET /admin/memory/user-overview?userId=...`                  | 用户设备和空间；viewer、admin、superadmin                              |
| `GET /admin/memory/fast?memorySpaceId=...`                    | Fast 列表；admin、superadmin                                           |
| `GET /admin/memory/fast-detail?memorySpaceId=...&fastId=...`  | Fast 详情；admin、superadmin                                           |
| `GET /admin/memory/long?memorySpaceId=...`                    | Long 列表；admin、superadmin                                           |
| `GET /admin/memory/long-detail?memorySpaceId=...&blockId=...` | Long 详情；admin、superadmin                                           |
| `POST /admin/memory/run-daily`                                | 请求体 `{ "memorySpaceId": "..." }`；仅 superadmin，异步返回 `batchId` |
| `GET /admin/memory/daily-status?batchId=...`                  | 查询 Daily 批次；admin、superadmin                                     |

除登录外，上述接口需携带 `Authorization: Bearer <token>`。响应使用 `{ ok: true, data }` 或 `{ ok: false, error }`。账号管理等更多字段见 [API.md](../apps/go-memory-admin-backend/API.md)；Daily 路由以当前源码为准。

## 7. 配置与运维注意事项

- **bootstrap 不会重置已有密码。** 已存在管理员时会跳过初始化；修改 `.env` 中的初始化密码不能修改已有账号密码，应使用改密接口。
- **数据库和向量配置必须一致。** schema 名采用字母或下划线开头、后接字母数字下划线，例如 `go_memory`；`go-memory` 会被适配器拒绝。修改 Embedding 维度不会自动转换历史向量。
- **手动 Daily 会修改业务数据。** 它不受调度器的 Fast 数量阈值限制。管理员进程和业务进程各有自己的运行状态，当前入口未注册跨进程 Dream Gate 或价值引擎，避免对同一空间同时触发 Daily。
- **监听成功不等于模型可用。** 登录只能验证管理员栈；JEV、LLM、Embedding 的实际调用还受地址、权限、模型和额度影响。
- **默认回环监听。** 对外提供管理访问时，通过受控网关配置 HTTPS 和访问范围；业务后端的无管理员鉴权运维路由不能替代本应用的角色权限。
- **停止进程。** 前台按 `Ctrl+C`，应用会停止接受新管理调用，等待在途调用后释放连接；不要把正在运行的长 Daily 当作已经完成。

## 8. 本地检查

```powershell
# 仓库根目录；不连接数据库或调用模型
npm run typecheck -w toy-go-memory-admin-backend
npm run build -w toy-go-memory-admin-backend
```

这些检查验证编译和类型，不代表生产数据库、登录或完整 Daily 已验证。
