# packages/memory —— 记忆系统包库

> 目录 `packages/memory`

基于 Cordis 插件架构的 Agent 长期记忆系统，按 v2 技术方案实现。跨包通过 `toy-*` 依赖互相协作，
持久化统一走 `toy-storage`（关系型 + 向量）与 `toy-storage-relational` / `toy-storage-vector` 协议。

## 核心概念

- **三层存储**：`Fast`（证据层，宽松追加）/ `Long`（认知层，Dream 整理而来）/ `Deep`（未来，不实现）。
- **在线链路**：对话期提取 Fast、检索 Fast/Long、Session 收尾生成价值反馈。
- **离线链路**：Daily Dream（Fast → Long）、Weekly Dream（Long 块结构整理）。
- **价值系统**：重要程度判断 + 反馈强化 + 幂律衰减 + 生命周期（自然遗忘）。

## 包清单

| 包 | 分层 | 职责 |
| --- | --- | --- |
| `toy-memory-space` | 基础 | 记忆空间：用户创建空间、绑定玩偶、软删除与解析当前空间 |
| `toy-memory-fast` | 存储 | Fast 证据层：记忆草稿追加、双通道检索、向量索引补写、Daily 消费入口 |
| `toy-memory-long` | 存储 | Long 认知层：记忆块结构、弱/强检索、只读查询、Daily/Weekly 的 `applyChanges` 入口 |
| `toy-memory-write` | 在线 | 对话期 Fast 提取与写入：把用户原话提取成记忆草稿并落库 |
| `toy-memory-read` | 在线 | 记忆联合检索编排：共享 Query Embedding，并行 Fast 与 Long，返回分组正文与降级状态 |
| `toy-memory-lifecycle` | 在线 | 在线记忆编排：解析记忆空间、JEV 门控提取，并把提取结果注入系统提示 |
| `toy-memory-tools` | 在线 | 记忆本地工具：`memory_read` 检索、`memory_write` 按 JEV 门控写入 |
| `toy-memory-feedback` | 在线 | Session 收尾价值反馈：判断每个已召回价值单元的用户态度 |
| `toy-memory-daily` | 离线 | Daily Dream：把 Fast 整理为 Long 的完整离线链路（八阶段 + 价值结算 + 原子提交） |
| `toy-memory-weekly` | 离线 | Weekly Dream：只整理已有 Long 块结构（SPLIT/RECLASSIFY/MERGE/RENAME + 价值迁移） |
| `toy-memory-scheduler` | 离线 | 定时调度：按空间配置的触发时间与阈值，到点运行 Daily / Weekly |
| `toy-memory-value` | 价值 | 价值引擎：反馈/重要程度/正文变化判断 + 强化、幂律衰减、生命周期计算 |
| `toy-memory-go-admin` | 运维 | 面向 Go 记忆系统的运维管理：按用户/空间浏览 Fast 与 Long |
| `toy-memory-go-backend` | 运维 | 仅供 Go conversation 调用的记忆读写 HTTP 门面 |

## 端到端链路

### 在线（对话期）

```
用户 Query
  ↓ toy-memory-lifecycle（解析空间 + JEV 门控「是否明确要求记住」）
  ↓ toy-memory-tools（memory_read / memory_write 工具）
  ↓ 并行：
  ├─ toy-memory-read：Fast + Long 联合检索 → 主 Agent 回答
  └─ toy-memory-write：Fast 提取 → 写入 Fast
  ↓
后续用户输入为已召回 Long 提供反馈证据
  ↓ Session 结束
toy-memory-feedback：对每条已召回记忆生成 Session 级价值反馈
```

### 离线（Dream）

```
toy-memory-scheduler：到点触发（每日 / 每周）
  ↓
toy-memory-daily：Daily Dream
  freeze → 巩固 → Session 内整理 → 跨 Session 整理 → 归属 → 生成 →
  容量整理 → 独立验证 → 价值结算与遗忘 → 原子提交
  ↓（Weekly 执行日）
toy-memory-weekly：Weekly Dream（只整理 Long 块结构）
  freeze → SPLIT → RECLASSIFY → MERGE → RENAME → 容量 → 价值迁移 → 提交
```

### 价值系统

```
toy-memory-value 的 ValueEngine 一个类实现三个契约：
  - FeedbackValueEngine（注册到 toy-memory-feedback）
  - DailyValueEngine（注册到 toy-memory-daily）
  - WeeklyValueEngine（注册到 toy-memory-weekly）
数值本身只以 opaque ValueState（valueData + valueVersion）存在 Long 里，记忆包不解析。
```

## 分层与依赖方向

```
运维：  memory-go-admin / memory-go-backend
价值：  memory-value ──────────────► memory-feedback / memory-daily / memory-weekly / memory-long
离线：  memory-scheduler ─────────► memory-daily / memory-weekly / memory-fast
        memory-daily ─────────────► memory-fast / memory-long / memory-feedback / memory-value
        memory-weekly ────────────► memory-long / memory-daily
在线：  memory-write / memory-read / memory-lifecycle / memory-tools / memory-feedback
存储：  memory-space / memory-fast / memory-long ──► toy-storage(-relational/-vector)
```

- **方向**：上层依赖下层；存储层只依赖 `toy-storage` 协议，不依赖业务包。
- **隔离单位**：所有包都以 `Scope`（`userId` + `memorySpaceId`）为隔离，Fast / Long / 反馈 / Dream 均按空间隔离。

## 关键数据表（关系型）

| 归属 | 表 | 用途 |
| --- | --- | --- |
| space | `toy_memory_spaces` / `toy_memory_space_devices` | 空间与玩偶绑定 |
| fast | `toy_memory_fast_records` / `toy_memory_fast_embedding_jobs` | Fast 记录与异步向量 |
| long | `toy_memory_long_blocks` / `_details` / `_aliases` / `_keywords` | Long 块、细节、别名 |
| feedback | `toy_memory_feedback_entries` | Session 价值反馈 |
| daily | `toy_memory_daily_batches` / `_checkpoints` / `_target_audits` / `_space_state` | Daily 批次、checkpoint、审计、空间状态 |
| weekly | `toy_memory_weekly_batches` / `_checkpoints` / `_ops` | Weekly 批次、checkpoint、结构操作审计 |
| scheduler | `toy_memory_schedules` | 每个空间的 daily/weekly 调度配置 |

向量集合：`toy_memory_fast_vectors`、`toy_memory_long_vectors`（块 summary 与细节 summary 平级存放）。

## 约定

- 每个包通过 Cordis `Service` 暴露，`declare module "cordis"` 增强 `Context`。
- 阶段化的离线包（daily/weekly）按 `stages/*` 目录组织，每阶段一个 `index.ts` + `README.md`。
- 模型能力统一走 `toy-llm` / `toy-jev` / `toy-embedding`，由宿主注入 provider/model 路由。
