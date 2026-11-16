# memory-eval-backend

独立评测后端：批量评测「对话 → extract → Fast → daily → Long」记忆系统全链路。
不改现有 memory 包，记忆数据落库（专用 schema `memory_eval`），eval 自己的进度/结果走 JSONL。

## 环境变量

本目录自带的 `.env`（自动加载，无需 `--env-file`；不存在的键按代码默认值）。
首次使用请复制 `.env.example` 为 `.env` 并填入真实值：

```powershell
cd apps/memory-eval-backend
copy .env.example .env   # 然后编辑 DATABASE_URL / DASHSCOPE_API_KEY / JEV_API_KEY 等
```

## 评测数据

LongMemEval 数据统一放在本应用的 `data/` 目录：

- `data/longmemeval_oracle.json`：小批量 smoke 命令和网页默认使用的数据集。
- `data/longmemeval_s_cleaned.json`：完整历史数据集，可通过 `--data` 指定。
- `data/internal-questions.json`：随源码维护的内部中文测试题。

前两个文件已从 `benchmarks/longmemeval/data/` 迁入。`data/longmemeval*.json` 已被 Git 忽略，首次克隆项目后需自行准备数据；内部中文测试题仍纳入版本管理。

CLI 和网页中的相对数据路径均以启动进程的工作目录为基准。使用下面的 npm workspace 命令，或先进入 `apps/memory-eval-backend` 再运行 CLI / Web 服务。

## 命令行（小数据）

```powershell
# 仓库根目录，首次需建立 workspace 软链
npm install

# 类型检查 + 单元测试（无需 DB/LLM）
npm run typecheck -w toy-memory-eval-backend
npm test -w toy-memory-eval-backend

# 端到端小数据 smoke（真实 Postgres + DashScope，读取本目录 .env）
npm run smoke:internal -w toy-memory-eval-backend
npm run smoke:longmemeval -w toy-memory-eval-backend

# 或直接（在 apps/memory-eval-backend 下）
node cli.mjs --adapter internal --limit 3 --out runs/smoke-internal
node cli.mjs --adapter longmemeval_v1 --data data/longmemeval_oracle.json --limit 2 --out runs/smoke-longmemeval
```

断点恢复：对同一 `--out` 目录重跑即自动跳过已 done / 已判题。

## Web（查看 + 启动评测）

```powershell
cd apps/memory-eval-backend
node serve.mjs            # 默认 http://127.0.0.1:8642
# node serve.mjs --out runs/smoke-internal --port 8642
```

浏览器打开后可：
- **启动评测**：选 adapter、填 limit/start/data/并发，点「开始评测」（后端 fire-and-forget 运行，SSE 实时推送进度）。
- **查看**：进度条、分能力得分、单题 drill-down（题目/gold/predicted/judge/检索/token）。

## 文件结构

```
adapters/     longmemeval_v1.ts（independent）+ internal.ts（independent）+ 契约 types.ts + helpers.ts
runner.mjs    建空间 → extract(串行) → daily → query/answer/judge(并发 10) + 断点
store.mjs     JSONL append+flush / run.json 原子写
resume.mjs    extract done / 已判 questionId 的恢复集合
conclusion.mjs  分能力表 + LLM 错题聚类 + records.jsonl + 可选 CSV
cli.mjs       命令行入口 · serve.mjs Web 服务（查看 + 启动）· web/ 前端
env.mjs / adapter-factory.mjs / run-once.mjs  环境加载 / adapter 创建 / 一次完整评测
```

## 约定

- **空间隔离**：每题一个独立记忆空间，命名 `<测试集名>-<测试时间>-<测试题号>`；玩偶与空间同名，`user = 测试集名`（如 `internal`、`longmemeval_v1`）。不同题目记忆互不污染。
- 运行目录：`--out` 指定；含 `run.json`、`extract_progress.jsonl`、`results.jsonl`、`records.jsonl`、`conclusion.md`。
- 断点恢复：对同一 `--out` 目录重跑即可，`runId` 保持不变，已 done 的 extract 与已判题被跳过。
- 不挂 value engine：daily 只做内容整理（无价值衰减/归档），与 `benchmarks/longmemeval` harness 一致。
- `extract_progress.jsonl` 的 `tokens` 记 `null`（`FastWrite.extract` 不暴露 usage，且不改 memory 包）。
