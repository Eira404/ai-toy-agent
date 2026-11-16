# toy-memory-daily

> 目录 `packages/memory/memory-daily`

Daily Dream 插件：把 **Fast（证据层）离线整理成 Long（认知层）** 的完整链路，基于 v2 技术方案实现。
含 Gate 排空、冻结、巩固价值计算、内容整理（Session 内 / 跨 Session / 归属 / 生成）、容量整理、独立验证、
价值结算与幂等提交。

## 定位

- **对话期**（本包之外）：`toy-memory-write` 产生 Fast，`toy-memory-read` 检索 Fast/Long，
  `toy-memory-feedback` 在 Session 收尾生成反馈。
- **本包（离线期）**：把待处理 Fast 整理成 Long 候选 → 归属到已有块或新建块 → 生成块内容 →
  容量整理 → 独立验证 → 价值结算与遗忘 → 原子提交。

## 挂载

```ts
import { Context } from "cordis"
import { MemoryDaily } from "toy-memory-daily"

const ctx = new Context()
await ctx.plugin(MemoryDaily, {
  llmProvider: "dashscope",
  llmModel: "qwen3.7-max",
  jevProvider: "typesafe", // 可选；省略/空串则禁用 JEV（阶段三降级）
  embeddingProvider: "dashscope",
  embeddingModel: "qwen3.7-text-embedding-flash",
})
```

依赖注入：`storage`、`memoryFast`、`memoryLong`、`memoryFeedback`、`llm`、`jev`、`embedding`。

## 服务 API（`ctx.memoryDaily`）

| 方法                          | 说明                                                                           |
| ----------------------------- | ------------------------------------------------------------------------------ |
| `registerValueEngine(engine)` | 注册唯一价值引擎（可选；未注册则阶段零跳过、阶段七不衰减不归档，记忆永不遗忘） |
| `registerGate(gate)`          | 注册 Dream Gate（可选；未注册则 `runDaily` 直接执行，供测试/单机环境）         |
| `runDaily(scope, options?)`   | 运行一次 Daily：请求 Gate → 冻结 → 阶段零~八 → 提交；`options.gateCredential` 用于复用组合流程已持有的 Gate |

## 配置（`DailyConfig`）

| 字段                                   | 必填 | 默认     | 说明                                                              |
| -------------------------------------- | ---- | -------- | ----------------------------------------------------------------- |
| `relationalSource`                     | 否   | `main`   | 关系型存储实例名                                                  |
| `llmProvider` / `llmModel`             | 是   | —        | LLM 路由与模型                                                    |
| `jevProvider`                          | 否   | 空串     | JEV 路由；空串禁用 JEV（Domain 降级 `self`、相关块跳过 JEV 筛选） |
| `embeddingProvider` / `embeddingModel` | 是   | —        | Embedding 路由与模型                                              |
| `maxAttempts`                          | 否   | 3        | 整体失败重试上限（含首次）                                        |
| `mapConcurrency`                       | 否   | 4        | 阶段内独立 item 的并行度（任务池并发上限）                        |
| `now`                                  | 否   | 系统时间 | 时间源注入（ISO 字符串），测试用固定时钟                          |

## 价值引擎契约（`DailyValueEngine`）

价值系统拆成三个接口：`toy-memory-feedback` 声明 `FeedbackValueEngine`（Session 收尾态度判断），
本包声明 `DailyValueEngine`（Daily 巩固价值计算），`toy-memory-weekly` 声明 `WeeklyValueEngine`（Weekly 价值迁移）。
引擎一个类实现多个接口，初始化时分别注册到各边。

```ts
export interface DailyValueEngine {
  settle(input: { state: ValueState; judgements: readonly FeedbackJudgement[] }): ValueState
  reinforceUpdated(input: {
    state: ValueState
    oldContent: UnitContent
    newContent: UnitContent
  }): Promise<ValueState>
  initialize(inputs: readonly DailyUnitInput[]): Promise<ValueState[]>
  decay(state: ValueState): ValueState
  max(a: ValueState, b: ValueState): ValueState
  lifecycle(state: ValueState): LifecycleStatus
}
```

- `ValueState` 定义在 `toy-memory-long`：只含 `valueData`（opaque JSON）+ `valueVersion`（string）。
  **lifecycle 不属于价值层**，它属于 block/detail 层（Long 的 `lifecycleStatus` 列），
  由 `lifecycle()` 从 `valueData` 解析得出，Daily 据此判断是否归档。
- `initialize` 内部判重要性（引擎可调 JEV），Daily 不传 `ImportanceLevel`。

## Dream Gate 契约（`DreamGate`）

「禁止新建 Session」的能力属于 Runtime；Daily 只依赖协作契约：

```ts
export interface DreamGate {
  acquire(scope: Scope): Promise<string> // 排空活跃/正在结束的 Session 后锁定，返回凭证
  release(scope: Scope, credential: string): Promise<void> // 幂等释放
}
```

`runDaily` 在 `acquire` 后用 `try/finally` 保证释放，凭证写入 `toy_memory_daily_batches.gate_credential`。

## 数据表（4 张）

| 表                               | 主键                                   | 用途                                                          |
| -------------------------------- | -------------------------------------- | ------------------------------------------------------------- |
| `toy_memory_daily_batches`       | `batch_id`                             | 批次主记录（幂等 + 状态机 + Gate 凭证 + 冻结范围 + 衰减开关） |
| `toy_memory_daily_checkpoints`   | `checkpoint_id`（`{batchId}:{stage}`） | 各阶段可信中间结果，失败从最后一个可信阶段重试                |
| `toy_memory_daily_target_audits` | `audit_id`                             | 阶段八按目标块运维审计（sourceFastIds + APPLY/LOCAL_ABANDON） |
| `toy_memory_daily_space_state`   | `memory_space_id`                      | 空间级状态（成功 Daily 计数供 Weekly 防饥饿）                 |

## 阶段流程

| checkpoint | 阶段                  | 输入 → 输出                                         | 模型                  |
| ---------- | --------------------- | --------------------------------------------------- | --------------------- |
| 0          | `freeze`              | 待处理 Fast/反馈 + 当前 Long → `FreezeBaseline`     | —                     |
| 1          | `consolidate-value`   | 冻结反馈 + Long 价值 → `ConsolidationResult`（R0）  | 价值引擎              |
| 2          | `consolidate-session` | 冻结 Fast → `SessionCandidate[]`                    | LLM                   |
| 3          | `consolidate-cross`   | Session 候选 → `LongCandidate[]`                    | LLM                   |
| 4          | `assign`              | Long 候选 → `CandidateAssignment[]`                 | JEV + Embedding + LLM |
| 5          | `generate`            | 归属方案 + 旧块 → `BlockChangePlan[]`               | LLM                   |
| 6          | `capacity`            | 变化方案 → `CapacityOutcome[]`                      | LLM（超阈值时）       |
| 7          | `verify`              | 容量结果 → `VerifyOutcome[]`（APPLY/LOCAL_ABANDON） | LLM                   |
| 8          | `settle`              | 验证结果 + R0 + 冻结旧 Long → `SettlementResult`    | 价值引擎              |
| 9          | `commit`              | 结算结果 → Long 变更 + 消费 Fast/反馈 + 审计        | Embedding             |

详见各阶段目录下的 `README.md`。

## 降级行为

| 条件                                   | 行为                                                                                         |
| -------------------------------------- | -------------------------------------------------------------------------------------------- |
| 无价值引擎（未 `registerValueEngine`） | 阶段零跳过；阶段七 INHERIT 透传旧值、INITIALIZE 写 `NO_VALUE_STATE` + `active`，不衰减不归档 |
| 无 JEV（`jevProvider` 为空）           | 阶段三 Domain 降级 `self`、相关块跳过 JEV 筛选（直接交给目标 LLM）                           |
| 无 Gate（未 `registerGate`）           | `runDaily` 直接执行（不排空）                                                                |

## 目录结构

```
src/
├── service.ts       # MemoryDaily：registerValueEngine / registerGate / runDaily
├── config.ts        # DailyConfig
├── gate.ts          # DreamGate 契约
├── stage.ts         # StageEnv（阶段运行上下文）
├── unit.ts          # unitKey（overview/detail 稳定键）
├── llm.ts           # extractText（LLM 文本拼接）
├── schema.ts        # 4 张表
├── relational.ts    # 行映射 + assertDailySchema
├── types.ts         # 存储类型 + CHECKPOINT_STAGE + DailyValueEngine
├── error.ts         # DailyMemoryError
└── stages/
    ├── freeze/              # 0 冻结
    ├── consolidate-value/   # 1 阶段零·巩固
    ├── consolidate-session/ # 2 阶段一
    ├── consolidate-cross/   # 3 阶段二
    ├── assign/              # 4 阶段三
    ├── generate/            # 5 阶段四
    ├── capacity/            # 6 阶段五
    ├── verify/              # 7 阶段六
    ├── settle/              # 8 阶段七
    └── commit/              # 9 阶段八
```

## 已知简化 / TODO

- **Gate 排空**：契约已就绪，但真正的「查活跃 Session → 等排空 → 锁定」实现由 Runtime 提供。
- **活动阈值**：`decayEnabled` 暂恒 `true`、`turnCount` 暂恒 0（未接活动阈值判定）。
- **重试/恢复**：`saveCheckpoint` 已就绪，但 `runDaily` 尚未实现「从 checkpoint 续跑 + 整体 ≤3 次 + 转运维」。
- 阶段一/二超容量分组归并、阶段三 title 双向包含 / 随机种子持久化 / 同批新建对齐、
  阶段六两轮修正（含 repairSuggestions 传递）等未实现（详见各阶段 README）。
- 阶段八为「幂等多步提交」（各包各自事务 + `dailyBatchId`），非跨包真事务。

## 测试与运行

```powershell
npm run test -w toy-memory-daily          # 内存 fake 的单元/集成测试
node --env-file=.env scripts/e2e-memory.mjs   # 真实 PostgreSQL + LLM/JEV/Embedding 的端到端
```
