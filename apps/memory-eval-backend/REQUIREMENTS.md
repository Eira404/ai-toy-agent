# 记忆系统评测后端（memory-eval-backend）需求文档

> 目的：批量评测「对话 → extract → Fast → daily → Long」这套记忆系统的效果。
> 约束：不改现有 memory 包，只新增；记忆数据落库，eval 自己的进度/结果走 JSONL；验证优先、简单。

## 1. 目标

搭建一个独立评测后端，用公开测试集 + 内部题跑通记忆系统全链路，产出：
分能力得分、错题分析、优缺点结论、原始记录；支持进度自动保存与断点恢复，不浪费 LLM token。

## 2. 架构

```
apps/memory-eval-backend
  ├─ adapters/
  │    ├─ longmemeval_v1.ts    # mode=shared，文本 500 题，5 能力
  │    └─ internal.ts          # mode=independent，内部中文题
  ├─ runner.mjs                # 建空间 → extract → daily → query → answer → judge
  ├─ store.mjs                 # JSONL 读写（append + flush，崩溃安全）
  ├─ resume.mjs                # 断点恢复
  ├─ conclusion.mjs            # 完成/中断 → LLM 结论 + 原始记录导出
  └─ web/                      # 极简前端：进度 + 分能力得分 + 单题结果
```

依赖：memory 包（仅 import，不改）+ Postgres（专用 schema）+ LLM（各环节可配不同 chain）。

## 3. 核心流程与并发

按 adapter 声明的 `mode` 建空间：

- `shared`：1 个空间，`userId = eval-<datasetId>`、`deviceId = datasetId`。
- `independent`：每题 1 个空间，`deviceId = questionId`（空间名即题号）。

每个空间的流程：

```
1. extract：串行，逐 turn（session/turn 顺序）→ memoryWrite.extract → Fast
2. daily：一次 memoryDaily.runDaily(scope)
3. 逐题（并发 10）：memoryRead.search(query) → answer LLM → judge LLM
```

并发约束（重要）：

- **extract 串行**：extract 内部 `listRecentBySession` 读最近已落库 Fast 做指代消歧，
  同 session 的 turn N 依赖 turn 1..N-1，必须顺序执行。
- **daily 串行**：一次 runDaily。
- **query/answer/judge**：单题内部顺序（query→answer→judge），题间并发 10。

## 4. Adapter 契约

每个数据集实现一个 adapter，把不同 schema 归一化成统一中间结构：

```
interface BenchmarkAdapter {
  id: string
  mode: "shared" | "independent"
  load(): Promise<void>                         // 读原始数据
  normalize(): Normalized                       // 归一化
  buildTurns(item): TurnExtraction[]            // 历史 → 逐 turn 的 extract 输入
  judge(question, predicted, gold): JudgePrompt // 判分 prompt（含 abstention rubric）
  metricGroups(): string[]                      // 分组（如 5 能力）
}

Normalized = {
  mode,
  items:
    | [{ spaceKey, history: Session[] }]                    // shared：一个历史
    | [{ spaceKey, questionId, history: Session[] }],       // independent：每题一个历史
  questions: [{ questionId, type, text, gold, evidenceIds? }],
}
```

`TurnExtraction`：`{ userMessage, recentConversation }`，逐 turn 喂给 `memoryWrite.extract`。

## 5. 持久化（JSONL，不落库）

| 文件 | 内容 |
|---|---|
| `run.json` | `{ runId, adapterId, configHash, mode, schema, status, counters, createdAt, updatedAt }` |
| `extract_progress.jsonl` | 每行 `{ runId, spaceKey, sessionId, turnId, status, writeId, tokens, error, ts }` |
| `results.jsonl` | 每行 `{ runId, questionId, type, question, gold, predicted, judge, retrieved, tokens, ts }` |

写入方式：整行 append + flush（崩溃安全、不交错）。

## 6. 恢复语义（不浪费 token）

- extract：读 `extract_progress.jsonl`，跳过 `status=done` 的 `(spaceKey, sessionId, turnId)`。
- daily：崩溃则**重跑一次**（不做阶段级 resume）。
- query/judge：读 `results.jsonl`，跳过已判的 `questionId`。
- in-flight（行写一半）：该单位重跑；LLM 非确定但 judge 对 gold 判，不破坏正确性，仅多花 token。

## 7. answer / judge prompt 契约

- **answer**：system「你根据下面给出的记忆内容回答用户问题，只能依据记忆内容，不确定就回答『无法确定』」；
  user = 检索到的 Fast/Long 正文 + 问题。
- **judge**：system「判断回答是否正确」，输入（题目、gold、predicted），输出 `{ correct, reason }`；
  abstention 规则：gold 为「无法确定 / not present」时拒答算对；gold 存在时拒答算错。

## 8. 结论报告（完成 / 中断）

- 完成：总体准确率 + 分能力表 + 错题聚类（按能力 + 错误类型：检索 miss / 生成错 / 幻觉 / 更新 miss / 时间 miss）+ 优缺点 + 优化建议。
- 中断：基于已完成部分出「部分结论（X/N）」。
- 原始记录：`records.jsonl`（每题全字段）+ 可选 CSV。

## 9. 前端（先能看能用）

进度条（题 X/N、当前阶段）、分能力得分、单题 drill-down（题目 / gold / predicted / judge / 检索结果 / token）。SSE 推送。

## 10. 命名与 schema

- schema：`memory_eval`（专用，隔离生产 `public`）。
- userId = `eval-<datasetId>`；deviceId = datasetId(shared) / questionId(independent)；空间名 = deviceId。

## 11. 里程碑

1. `store.mjs` + `resume.mjs`（JSONL 读写 + 恢复）。
2. 一个 adapter（先 `longmemeval_v1`）+ `runner`（extract→daily→query→answer→judge）。
3. `conclusion.mjs`（结论 + 记录导出）。
4. `web/` 极简前端。
