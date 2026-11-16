# go-memory-service-backend

提供给 **Go conversation** 调用的记忆后端服务启动入口（应用，非库）。它装配完整的
记忆系统（空间 / Fast 证据 / Long 长期 / 反馈 / Daily 整理 / 定时调度）并暴露两条
Go 门面路由 `POST /memory/read`、`POST /memory/write`。

与 `apps/backend`（完整玩偶后端）的区别：本应用**不装配** Session / Agent / 设备 /
用户 / 各类分析插件，只服务记忆读写与 Daily。

## 链路

```
Go conversation → Go memory-service → 本后端
  POST /memory/read   { context:{userId,deviceId,sessionId,turnId}, query, mode? }
  POST /memory/write  { context:{...}, memories:[{title,summary,body}] }
      ↓ MemoryGoBackend
      ├─ memorySpace.resolveOrCreateMemorySpace(userId, deviceId)
      │     └─ 新建时 → memoryScheduler.setDailySchedule(dailyAt, timeZone, 阈值)
      ├─ memoryRead.search / memoryWrite.write
      └─ 返回精简后的 { status, fast, long } / { kind, writeId, records }
```

成功 envelope 为 `{ ok: true, data }`，失败为 `{ ok: false, error: { code, message } }`。

## 配置（config.yaml）

结构与模型路由都在 [config.yaml](./config.yaml)，密钥通过 `${ENV}` 插值引用环境变量，
不写进 YAML。核心概念是**降级链**：

- `llm.chains` / `embedding.chains`：有序候选 `[{provider, model}]`，前一个可降级失败则下一个。
- `jev.chains`：有序候选 `[{provider, model}]`（与 llm/embedding 一致，model 在链条目里，adapter 不持有模型）。
- `memory.*`：把记忆各环节映射到链名——
  - `memory.extract.llm` → `FastWrite.extract()`（提取 Fast 证据；直接 `write()` 不经 LLM）
  - `memory.daily.llm` / `memory.daily.jev` / `memory.daily.embedding` → `MemoryDaily`
  - `memory.embedding` → `FastMemory` / `MemoryRead` 共用

`memory.extract.llm` 与 `memory.daily.llm` 可以指向**不同链**（例如提取用 qwen-flash、
整理用 qwen-max）。adapter 的 `type` 决定装配哪个插件（`openai-responses` /
`openai-compatible` / `typesafe` / `llm`），可声明多个 adapter 以支持跨供应商降级。

JEV 的 adapter 有两种，都**不持有 model**（model 由 `jev.chains` 的链条目决定）：
- `type: typesafe`：TypeSafe HTTP 服务（只含连接信息 `baseURL`/`apiKey`）。
- `type: llm`：桥接到 LLM（`llmProvider` 指向 `llm.chains` 的链名或 `llm.adapters` 的 adapter 名）。

> 依赖零第三方 YAML 库：`src/yaml.ts` 是一个面向本配置的 YAML 子集解析器（块式
> mapping / sequence / 标量 / 注释），不支持 flow 集合等完整 YAML 特性。

## 环境变量

见 [.env.example](./.env.example)。config.yaml 里 `${VAR}` / `${VAR:-默认}` 从这里取值。
必填：

- `DATABASE_URL`：PostgreSQL 连接串（关系表 + pgvector 可同一库）。
- `DASHSCOPE_RESPONSES_BASE_URL`：LLM Responses API 地址。
- 建议同时设置 `DASHSCOPE_API_KEY`、`DASHSCOPE_EMBEDDING_BASE_URL`、`JEV_*`。

启动时 `PostgresStorage` / `PgvectorStorage` 以 `createMissing: true` 自动建表/建集合，
无需手工迁移。

## 运行

```sh
npm install
npm run build -w toy-go-memory-service-backend
npm run start -w toy-go-memory-service-backend
```

工作区 start 脚本会自动读取本应用目录下的 .env，也可以进入应用目录启动：

```sh
cd apps/go-memory-service-backend
npm start
```

启动后默认监听 `http://127.0.0.1:3100`（`config.yaml` 里 `http.port` 可改，或用 `PORT` 覆盖）。

## 路由

| 方法 | 路由 | 用途 |
|---|---|---|
| POST | `/memory/read` | Go 调用：检索记忆（弱/强） |
| POST | `/memory/write` | Go 调用：写入记忆 |
| GET/POST | `/memory/spaces*` | 运维：空间管理/查看 |
| GET | `/memory/fast/*` | 运维：Fast 证据查看 |
| GET | `/memory/long/*` | 运维：Long 长期记忆查看 |
| POST | `/memory/daily/run` | 运维：手动触发一次 Daily |

## 说明

- 首次对某个 `(userId, deviceId)` 读/写时，自动创建记忆空间（`name=deviceId`）并
  挂 daily 调度（`config.yaml` 里 `memory.scheduler.*` 控制，可用 `DAILY_*` 覆盖）。
- `MemoryScheduler` 每 60s 扫描到期调度，达到阈值才触发 `MemoryDaily.runDaily`。
- Daily 的 Dream Gate 与价值引擎均未注册（单机/临时使用）；生产多实例环境需按
  `toy-memory-daily` 契约另行注入 Gate 与价值引擎。

## Windows 与 Go 本地联调（2026-11-16）

- 本机应用 `.env` 使用 `PORT=19199`、`HOST=127.0.0.1`、`DB_SCHEMA=go_memory`；schema 使用字母、数字和下划线，`go-memory` 不被存储适配器接受。
- Go 根目录 `.env` 对应设置 `SOUNDBOX_MEMORY_BASE_URL=http://host.docker.internal:19199`。Docker Desktop 已验证可以访问宿主的回环监听。
- 启动入口必须挂载 `ParallelExecutor`，否则 Daily 的依赖未满足，Scheduler 和两个 HTTP 门面会一起挂起，即使端口已经监听也只返回 404。入口现在会在报告成功前检查业务插件是否就绪。
- Go 已兼容当前门面返回的 `{status,fast:[],long:[]}` 正文数组，同时保留完整命中结构的兼容校验。
- 已真实验证 PostgreSQL 写入、自动向量索引、跨 Session 语义检索，以及 Go 对话中的保存和新会话查询；文字与 TTS 音频均有返回。
- Daily 调度记录已创建；本次没有触发完整 Daily Dream，也没有接入 Go 的清空、解绑和反馈迁移。

Go 仓库的 `scripts/start-local-memory.ps1` 可以后台启动本应用并检查业务路由就绪；联调程序位于该仓库的 `test/memory_integration/`。
