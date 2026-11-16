# Go 记忆业务后端使用说明

## 1. 定位与功能

应用目录：`apps/go-memory-service-backend`。npm workspace 名：`toy-go-memory-service-backend`。

这是面向 Go conversation / Go memory-service 的 Node.js 记忆后端。它装配空间管理、Fast 证据、Long 长期记忆、反馈存储、读写、Daily 整理和定时调度，不承担会话 Agent、语音或设备通信本身。

主要调用链：

```text
Go conversation → Go memory-service → 本应用 HTTP API
                                    ├─ /memory/write：结构化记忆直接写入 Fast
                                    ├─ /memory/read：Fast / Long 联合检索
                                    └─ Scheduler → Daily：Fast 整理到 Long
```

- Go 调用门面只需要上下文中的 `userId`、`deviceId`、`sessionId`、`turnId`，空间由本后端解析。
- 某个用户与设备首次读写时，自动创建或解析空间；新建空间会创建 Daily 调度记录。
- `/memory/write` 接收已经整理好的 `title`、`summary`、`body`，调用直接写入，不再通过 LLM 提取一次。
- Fast 写入后会触发异步向量索引；写入成功不等于向量索引已完成。
- `/memory/read` 支持 `weak` / `strong`，返回精简正文，移除内部命中 ID 和分数。
- 同时提供空间、Fast、Long 查看及手动 Daily 等内部运维路由。

管理员账号、登录和权限管理由 [管理员后端](./go-memory-admin-backend.md)提供；离线质量评测由 [评测后端](./memory-eval-backend.md)提供。

## 2. 启动前准备

1. Node.js `>=20.19.0` 和 npm；三个后端统一运行时可使用 Node.js 24.x。
2. 已建好的 PostgreSQL 数据库，以及目标数据库中已安装的 `vector` 扩展。
3. LLM Responses API、Embedding API、**生产必填的 JEV 服务**及相应模型权限。
4. 数据库账号具有目标 schema 的建表、读写权限。启动时 `createMissing: true` 创建缺失表和向量集合，不会自动安装扩展，也不会自动修复所有历史结构冲突。

数据库管理员可在目标数据库执行：

```sql
CREATE EXTENSION IF NOT EXISTS vector;
```

## 3. 配置文件和环境变量

配置入口为 [config.yaml](../apps/go-memory-service-backend/config.yaml)，密钥及可选覆盖值参考 [.env.example](../apps/go-memory-service-backend/.env.example)。

- npm workspace 的启动脚本在应用目录执行，读取该目录 `.env`，不是仓库根目录的 `.env`。
- 配置加载顺序是读取 YAML、展开 `${VAR}` / `${VAR:-默认值}`、校验，再装配服务。
- 通过 `CONFIG_FILE` 可切换 YAML，建议使用绝对路径。
- 操作系统已有环境变量优先于 `.env`，修改后需重启服务。

| 变量                           | 用途与默认值                                                 |
| ------------------------------ | ------------------------------------------------------------ |
| `DATABASE_URL`                 | 必填；关系数据和向量集合共用该 PostgreSQL 连接               |
| `DB_SCHEMA`                    | 默认 `public`；建议业务记忆使用独立 schema，例如 `go_memory` |
| `HOST` / `PORT`                | 默认 `127.0.0.1` / `3100`                                    |
| `DASHSCOPE_RESPONSES_BASE_URL` | 必填；Responses API 根地址或完整 `/responses` 地址           |
| `DASHSCOPE_API_KEY`            | 必填；默认同时用于 LLM 和 Embedding                          |
| `DASHSCOPE_EMBEDDING_BASE_URL` | 必填；Embedding API 根地址或完整 `/embeddings` 地址          |
| `EMBEDDING_DIMENSIONS`         | 默认 `1024`；必须匹配模型输出和数据库向量列                  |
| `JEV_BASE_URL` / `JEV_API_KEY` | 生产必填；TypeSafe JEV 地址和密钥                            |
| `DAILY_AT`                     | `HH:mm`；未设置时，每个新建空间随机选择 `02:00`–`02:59`      |
| `DAILY_TIME_ZONE`              | 默认 `Asia/Shanghai`                                         |
| `DAILY_MIN_PENDING_FAST`       | 默认 `10`；到期时未整理 Fast 达到阈值才触发 Daily            |

模板 JEV 地址和密钥为空，必须补齐。不要把历史测试中的“JEV 可选”理解为生产配置建议。

## 4. 模型、调用链与 JEV

本应用的模型名在 YAML 中配置。`LLM_MODEL`、`EMBEDDING_MODEL`、`JEV_MODEL` 不是当前默认 YAML 的模型覆盖入口。

| 配置位置                                   | 当前模板作用                                        |
| ------------------------------------------ | --------------------------------------------------- |
| `llm.chains.extract`                       | Fast 提取链，候选为 `qwen3.5-flash`、`qwen3.7-max`  |
| `llm.chains.daily`                         | Daily LLM 链，候选为 `qwen3.7-max`                  |
| `embedding.chains.embed`                   | Fast 索引、检索和 Daily 向量写入使用的链            |
| `jev.chains.main`                          | TypeSafe JEV 模型候选，之后可降级到 LLM JEV adapter |
| `memory.extract.llm`                       | 指向提取链；直接 `/memory/write` 不执行提取         |
| `memory.daily.llm` / `.jev` / `.embedding` | 指向 Daily 使用的三个链名                           |
| `memory.embedding`                         | 指向 Fast 与 MemoryRead 使用的 Embedding 链名       |

`adapters` 中配置连接信息；`chains` 的每个条目配置 `provider` 和 `model`。链内 provider 指向 adapter 名；`memory.*` 指向链名。降级只在运行时判定为可降级的错误上发生，不代表任何配置错误都会自动跳过。

JEV 通过 `memory.daily.jev: main` 连接到 `jev.chains.main`。模板配置 TypeSafe JEV，并保留 `type: llm` 兜底。兜底不替代生产 JEV 地址、密钥及模型权限的准备。JEV 模型放在链条目，不放在 adapter 配置里。

YAML 使用项目自带的子集解析器，采用现有块式 mapping / sequence 写法；不要引入 flow 集合、锚点等完整 YAML 特性。

## 5. 启动步骤

以下 PowerShell 命令从仓库根目录执行：

```powershell
cd D:\code\node\ai-toy-agent-v4
npm install
npm run build

if (-not (Test-Path apps/go-memory-service-backend/.env)) {
  Copy-Item apps/go-memory-service-backend/.env.example apps/go-memory-service-backend/.env
}
```

编辑应用 `.env`，填入数据库、LLM、Embedding、JEV 配置，再检查 YAML 中的模型与链。随后启动：

```powershell
npm run start -w toy-go-memory-service-backend
```

默认监听 `http://127.0.0.1:3100`。也可以进入应用目录执行 `npm start`。只修改本应用源码时可执行 `npm run build -w toy-go-memory-service-backend`；首次或依赖包变化后需要构建依赖，不能只编译入口应用。

以下请求可检查运维路由是否已经挂载，不触发模型读写：

```powershell
Invoke-RestMethod -Uri 'http://127.0.0.1:3100/memory/spaces'
```

成功只说明空间查询路径可用，不代表三类模型服务或 Daily 已通过完整验证。端口监听成功但业务路由返回 404 时，应检查插件依赖和启动错误，不能只依据端口判断就绪。

## 6. Go 读写接口

默认 JSON 响应封装为 `{ ok: true, data }`；失败为 `{ ok: false, error: { code, message } }`。

写入：`POST /memory/write`。

```json
{
  "context": {
    "userId": "demo-user",
    "deviceId": "demo-device",
    "sessionId": "demo-session",
    "turnId": "demo-turn-1"
  },
  "memories": [
    {
      "title": "咖啡偏好",
      "summary": "用户喜欢不加糖的冰美式",
      "body": "用户明确表示喜欢喝不加糖的冰美式。"
    }
  ]
}
```

返回 `kind`、`writeId` 和正文投影 `records`。同一轮次的幂等标识使用上下文中的 session / turn；每次独立的新写入应使用正确的新轮次标识。

读取：`POST /memory/read`。

```json
{
  "context": {
    "userId": "demo-user",
    "deviceId": "demo-device",
    "sessionId": "demo-session-2",
    "turnId": "demo-turn-2"
  },
  "query": "用户喜欢喝什么咖啡？",
  "mode": "strong"
}
```

返回 `status`、`fast` 和 `long` 正文数组。未传 `mode` 时按弱检索处理。读写均通过 `userId + deviceId` 解析空间，跨 session 不等于跨空间。

## 7. 运维与配置注意事项

- **数据库对应关系：** 管理员后端必须使用同一 `DATABASE_URL` 和 `DB_SCHEMA`；Go 主业务数据库不要求与 Node 记忆数据库相同。schema 名允许字母数字下划线，首字符为字母或下划线，例如 `go_memory`，不要写成 `go-memory`。
- **向量一致性：** 业务、管理员后端的维度和模型语义空间应保持一致。改变模型或维度时需规划历史向量重建，不能只改 `.env`。
- **已有调度不会随默认值自动更新：** `DAILY_*` 在门面新建空间时用于写入调度。修改环境变量不会批量重写数据库中既有空间的调度记录。调度器默认每 60 秒扫描到期任务。
- **手动 Daily：** `POST /memory/daily/run` 接收 `{ "userId": "...", "memorySpaceId": "..." }`，等待执行结果；与管理员后端异步返回 `batchId` 的 `/admin/memory/run-daily` 不同。
- **其他运维能力：** `/memory/spaces` 提供空间创建、查询、重命名、软删除、恢复和绑定管理；`/memory/fast/list`、`/memory/long/list` 查看内容；`POST /memory/fast/embedding-jobs` 可补跑 Fast 索引。这些内部路由当前没有管理员登录鉴权。
- **网络范围：** 默认仅监听回环。容器或远端 Go 服务需要配置可达地址、端口和网络策略；宿主上的 `127.0.0.1` 与容器内的 `127.0.0.1` 含义不同。当前仓库不配置 Go 侧连接地址。
- **并发与价值处理：** 当前入口未注册跨进程 Dream Gate 或价值引擎。多实例或管理员手动 Daily 与定时任务并行时，需要额外保证同空间互斥；装配反馈存储不等于已提供 Go 反馈写入接口。
- **停机：** 前台 `Ctrl+C` 会卸载服务、数据库连接和定时器；长期运行请由进程管理器维护进程生命周期。

## 8. 本地检查

```powershell
# 仓库根目录；不连接数据库或调用模型
npm run typecheck -w toy-go-memory-service-backend
npm run build -w toy-go-memory-service-backend
```

这些检查验证编译和类型，不代替真实数据库读写、Embedding、JEV 或完整 Daily 的联调。
