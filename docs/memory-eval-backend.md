# 记忆评测后端使用说明

## 1. 定位与功能

应用目录：`apps/memory-eval-backend`。npm workspace 名：`toy-memory-eval-backend`。

这是记忆系统的离线批量评测入口，承担原 benchmark 的后端职责，提供 CLI 和本地 Web 页面。它直接装配当前记忆包，不通过 Go 记忆业务后端的 HTTP 接口运行，因此无需先启动另外两个后端。

评测链路：

```text
加载测试题 → 每题建立独立空间 → 逐轮 extract 写 Fast → Daily 整理
          → 强检索 Fast / Long → LLM 回答 → LLM 判分 → 汇总报告
```

支持：

- `internal`：内部中文测试题，覆盖事实、时间、更新、偏好和无法回答等能力。
- `longmemeval_v1`：加载 LongMemEval JSON 数据集。
- 以 JSONL 记录提取进度、逐题检索、回答、判分与部分 token 用量。
- 同一输出目录断点续跑，生成总体和分能力得分、错题分析及可选 CSV。
- Web 页面启动评测、接收 SSE 进度、查看逐题结果和当前运行状态。

当前两个 adapter 都按题隔离记忆空间。`userId` 为 adapter 名，设备及空间名包含数据集、runId 和题号，避免不同题目互相污染。

## 2. 运行依赖与数据隔离

- 应用声明 Node.js `>=22.6.0`，入口是 `.mjs`，会直接导入 adapter 的 `.ts`。本文命令使用无需额外 TypeScript loader 的 Node.js 24.x；当前工作环境为 24.x。
- 首次需安装整个 workspace 并构建依赖包。应用本身没有 `build` 或 `start` npm 脚本，CLI / Web 直接执行源文件。
- PostgreSQL 需预先安装 `vector` 扩展，账号需建 schema、建表及读写权限。
- **生产评测 JEV 必填**，同时需要 LLM、Embedding 的有效地址、密钥和模型权限。历史测试的可选 JEV 分支不作为本文使用方式。
- 记忆数据固定写入 `memory_eval` schema，代码中常量指定，`DB_SCHEMA` 环境变量不能覆盖。可以复用数据库实例，但业务后端应使用其他 schema；也可单独使用评测数据库。
- 评测结果写到本地 `runs/`，删除输出目录不会自动删除数据库内的评测记忆，删除数据库记忆也会影响续跑。

## 3. 环境配置

复制应用 [.env.example](../apps/memory-eval-backend/.env.example) 后填写实际值。CLI 和 Web 都通过 `env.mjs` 自动加载应用目录 `.env`，无需 `--env-file`；已有进程环境变量优先。此应用不读取前两个后端的 YAML。

| 变量                           | 用途与注意事项                                                  |
| ------------------------------ | --------------------------------------------------------------- |
| `DATABASE_URL`                 | 必填；评测记忆数据库连接，schema 固定 `memory_eval`             |
| `DASHSCOPE_RESPONSES_BASE_URL` | 必填；Responses API 根地址或完整 `/responses` 地址              |
| `DASHSCOPE_API_KEY`            | 必填；LLM 和 Embedding 共用                                     |
| `LLM_MODEL`                    | 提取、Daily、回答、判分和报告分析共用；未设置默认 `qwen3.7-max` |
| `DASHSCOPE_EMBEDDING_BASE_URL` | 必填；Embedding API 根地址或完整 `/embeddings` 地址             |
| `EMBEDDING_MODEL`              | 未设置默认 `qwen3.7-text-embedding-flash`                       |
| `JEV_MODEL`                    | 生产必填；模板为 `jev-latest`，应填写实际可用的模型名           |
| `JEV_BASE_URL` / `JEV_API_KEY` | 生产必填；TypeSafe JEV 服务地址和密钥                           |

空字符串不会触发 `LLM_MODEL` / `EMBEDDING_MODEL` 的默认值，避免保留空的模型配置。JEV 通过运行时注册的 `jev-main` 链将 `typesafe` adapter 和 `JEV_MODEL` 绑定。

Embedding 维度在 `runner.mjs` 固定为 `1024`，`EMBEDDING_DIMENSIONS` 不能覆盖。所选模型输出必须与之相符；调整维度需要同步修改代码及评测数据库向量结构。

Responses adapter 会为未以 `/responses` 结尾的根地址追加 `/responses`；Embedding adapter 同理追加 `/embeddings`。确保地址与供应商实际接口匹配，而不是仅根据变量名判断。代码要求 Responses 能力，并非只支持 Chat Completions 就足够。

## 4. 数据集位置

数据统一位于 `apps/memory-eval-backend/data/`：

| 文件                         | 用途                                   | Git 状态                   |
| ---------------------------- | -------------------------------------- | -------------------------- |
| `internal-questions.json`    | 内部中文测试题                         | 随源码维护                 |
| `longmemeval_oracle.json`    | LongMemEval smoke 命令和网页的默认数据 | 被忽略，首次克隆需自行准备 |
| `longmemeval_s_cleaned.json` | 含完整历史的 LongMemEval 数据          | 被忽略，首次克隆需自行准备 |

两个 LongMemEval 文件已从旧 benchmarks 目录迁入，当前运行不依赖该旧目录。JSON 支持实例数组或 `{ "data": [...] }`，实例含 `question_id`、`question_type`、`question`、`answer`、`haystack_sessions` 等字段。

## 5. 首次准备

从仓库根目录执行以下 PowerShell 命令：

```powershell
cd D:\code\node\ai-toy-agent-v4
npm install
npm run build

if (-not (Test-Path apps/memory-eval-backend/.env)) {
  Copy-Item apps/memory-eval-backend/.env.example apps/memory-eval-backend/.env
}
```

随后编辑应用 `.env`，填好 PostgreSQL、LLM、Embedding、JEV 配置，并准备要用的数据文件。单独构建两个 Go 入口应用不会保证评测所需的全部依赖已经构建。

## 6. CLI 启动

最小批量 smoke 命令，从仓库根目录执行：

```powershell
# 3 道内部题
npm run smoke:internal -w toy-memory-eval-backend

# 2 道 LongMemEval 题；需要 data/longmemeval_oracle.json
npm run smoke:longmemeval -w toy-memory-eval-backend
```

自定义参数时，先进入应用目录：

```powershell
cd D:\code\node\ai-toy-agent-v4\apps\memory-eval-backend
node cli.mjs --help
node cli.mjs --adapter internal --limit 3 --out runs/internal-demo --concurrency 2 --csv
node cli.mjs --adapter longmemeval_v1 --data data/longmemeval_s_cleaned.json --start 0 --limit 2 --out runs/longmemeval-demo --concurrency 2
```

| 参数            | 说明                                                                       |
| --------------- | -------------------------------------------------------------------------- |
| `--adapter`     | 必填：`internal` 或 `longmemeval_v1`                                       |
| `--data`        | LongMemEval 必填；CLI 相对路径以当前工作目录为基准                         |
| `--start`       | 起始题目索引，默认 `0`                                                     |
| `--limit`       | 题目数量；不传可能加载整个数据集，首次建议显式设为 `1`–`3`                 |
| `--out`         | 输出目录；默认 `runs/<adapter>-<时间戳>`                                   |
| `--concurrency` | 检索、回答和判分阶段的题间并发，默认 `10`；提取及逐空间 Daily 仍按顺序执行 |
| `--csv`         | 额外导出 `records.csv`                                                     |

这些 smoke 命令是真实模型和数据库评测，会产生 API 用量并写入数据，区别于单元测试。本文命令显式使用较低并发，便于首次排查模型限流或超时。

## 7. Web 启动与使用

```powershell
cd D:\code\node\ai-toy-agent-v4\apps\memory-eval-backend
node serve.mjs

# 或指定展示目录与端口
# node serve.mjs --out runs/internal-demo --port 8643
```

默认打开 `http://127.0.0.1:8642`。Web 固定绑定 `127.0.0.1`，端口通过 `--port` 设置，`HOST` / `PORT` 环境变量不是此入口的配置方式。启动 Web 只加载查看服务，点击“开始评测”才装配模型和数据库执行评测，因此网页可打开不等于模型配置有效。

页面支持选择 adapter、数据路径、start、limit、并发和 CSV，显示进度、分能力得分与逐题详情。单个 Web 进程同一时刻只接受一个评测任务，运行中再次启动返回 409。

路径规则：

- **网页数据路径**相对于应用目录解析，例如 `data/longmemeval_oracle.json`，不受启动工作目录影响。
- **CLI 数据路径**相对于进程工作目录解析。本文先进入应用目录，保持写法一致。
- Web 新任务默认输出到应用的 `runs/`。启动时未指定 `--out`，会选择 `runs/` 下最近修改的已有 `run.json` 目录展示。
- `--out` 只指定启动后的查看目录；网页新建任务默认生成新的输出目录，不会自动续跑当前查看目录。

Web 提供 `/api/run`、`/api/results`、`/api/question/:id`、`/api/events`、`/api/running` 和 `POST /api/run/start`。它没有管理员账号鉴权，适合本地评测使用。

## 8. 输出、续跑和结果判断

| 输出文件                 | 内容                                                           |
| ------------------------ | -------------------------------------------------------------- |
| `run.json`               | runId、状态、进度计数和配置摘要                                |
| `extract_progress.jsonl` | 逐轮提取进度及错误                                             |
| `results.jsonl`          | 逐题问题、标准答案、回答、判分、检索内容和回答/判分 token 用量 |
| `records.jsonl`          | 报告导出的逐题记录                                             |
| `records.csv`            | 使用 `--csv` 时生成                                            |
| `conclusion.md`          | 总体及分组得分、错题分析和结果索引                             |

中断后用**相同数据集、模型、参数和同一个 `--out`** 重新执行 CLI：保留原 runId，跳过已完成提取及已判分问题。更换数据、模型或评测范围时使用新的输出目录；当前代码记录配置哈希，但不会据此严格拒绝不匹配的续跑。

注意以下边界：

- Daily 没有独立的阶段完成续跑标记；未完成的 run 重启时会再次进入 Daily，可能产生额外调用。
- 已完成的 run 重跑会跳过主流程，但会重新生成结论，错题分析仍可能调用 LLM。
- 题目执行失败会记录错误并可能使状态变为 `partial`。Daily 失败会尝试两次并保存 `dailyError`；当前最终 `done` / `partial` 主要取决于题目执行是否失败，**`done` 不保证所有 Daily 都成功**，还需看日志、`dailyError` 和逐题检索内容。
- 提取 token 当前记为 `null`，逐题 token 主要包含回答和判分，不能用作完整流水线费用总计。
- 当前不装配价值引擎、定时调度器或跨进程 Dream Gate；评测聚焦内容整理与问答质量。
- 模型判分不是人工验收。评测中的回答、判分与分析共用 LLM 配置，比较结果时应保留使用的数据、模型和配置。

## 9. 不调用真实服务的检查

```powershell
# 仓库根目录
npm test -w toy-memory-eval-backend
npm run typecheck -w toy-memory-eval-backend
```

单元测试和类型检查无需数据库或模型。完整评测另行使用上面的 smoke 命令；不要把单元测试通过等同于生产 JEV、Embedding 或 Daily 已验证。
