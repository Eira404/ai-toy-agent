# toy-memory-scheduler

> 目录 `packages/memory/memory-scheduler`

记忆定时任务调度插件：维护每个记忆空间的 daily 调度配置，按周期扫描「到期且待整合 Fast 达阈值」的调度，
到点调用 `memoryDaily.runDaily` 完成一次 Daily Dream。未来 weekly 在本包基础上扩展。

## 定位

- **对话期**（本包之外）：`toy-memory-write` 产生 Fast，`toy-memory-feedback` 在 Session 收尾生成反馈。
- **`toy-memory-daily`**：纯执行器——「给我一个 scope，我跑一次完整 Daily」，不感知时间、不感知调度。
- **本包（调度期）**：拥有调度配置、决定「何时 / 对谁 / 是否满足阈值地」调 `runDaily`，并处理去重锁、
  并发上限与跨天推进。

## 触发语义

- 每个记忆空间一份调度，`dailyAt` 是每天触发的钟点（`"HH:mm"`，24 小时制）。
- **时区换算**：`dailyAt` 只是墙钟时间，接口可传入它所在的 IANA 时区 `timeZone`（省略按服务器时区），
  据此把「用户时间 + 时区」换算成服务器绝对时间 `next_run_at` 写入。无论用户和服务器是否同区，
  触发都发生在用户所选时区的 HH:mm。
- 到期后还需满足 **`minPendingFast` 阈值**（未消费 Fast ≥ 阈值）才真正运行；阈值未达则**当天放弃**，
  直接推进到下一个计划点，不在当天反复判断。
- **不补跑**：`runDaily` 的冻结阶段会取走该空间全部未消费 Fast，停机错过的时间点下次触发自然带走积压，
  无需 catch-up。

## 挂载

```ts
import { Context } from "cordis"
import { MemoryScheduler } from "toy-memory-scheduler"

const ctx = new Context()
await ctx.plugin(MemoryScheduler, {
  // relationalSource?: string     关系型实例名，默认 "main"
  // scheduleTickMs?: number       扫描周期，默认 60000（1 分钟）
  // maxConcurrentRuns?: number    单轮扫描并发运行 Daily 上限，默认 3
  // now?: () => string            时间源注入，测试用
})
```

依赖注入：`storage`、`memoryDaily`、`memoryFast`。

## 服务 API（`ctx.memoryScheduler`）

| 方法 | 功能 | 入参 | 返回 |
|---|---|---|---|
| `setDailySchedule(input)` | 设置/更新一个空间的 daily 调度（整行 upsert），并按「时间 + 时区」换算下次触发时间 | `SetDailyScheduleInput` | `DailySchedule` |
| `getDailySchedule(scope)` | 读一个空间的调度 | `{ userId, memorySpaceId }` | `DailySchedule \| null` |
| `disableSchedule(scope)` | 关闭调度（保留配置，可重新启用） | `{ userId, memorySpaceId }` | `void` |
| `runDue()` | 手动触发一轮扫描（后台定时器也调用它） | — | `readonly SweepOutcome[]` |

```ts
interface SetDailyScheduleInput {
  userId: string
  memorySpaceId: string
  dailyAt: string            // "HH:mm"
  timeZone?: string          // IANA 时区（如 "Asia/Shanghai"），省略按服务器时区
  minPendingFast?: number    // 阈值，默认 1
  enabled?: boolean          // 默认 true
}

type SweepOutcome =
  | { memorySpaceId: string; triggered: true; batchId: string }
  | { memorySpaceId: string; triggered: false; reason: "below-threshold" | "claim-lost" }
```

## 数据表（1 张）

| 表 | 主键 | 用途 |
|---|---|---|
| `toy_memory_schedules` | `memory_space_id` | 每空间一份 daily 调度：钟点、开关、阈值、下次触发时间 |

`next_run_at` 是调度器扫描依据；触发或「当天放弃」后都推进到下一个计划点。多实例部署时，
触发前用「条件更新 `next_run_at`」抢占，只有抢到的实例真正运行，保证同一空间同一时刻只跑一次。

## 目录结构

```
src/
├── service.ts       # MemoryScheduler：setDailySchedule / getDailySchedule / disableSchedule / runDue
├── config.ts        # SchedulerConfig
├── schema.ts        # 1 张表
├── relational.ts    # 行映射 + assertSchedulerSchema + 过滤辅助
├── types.ts         # DailySchedule / SetDailyScheduleInput / SweepOutcome
├── time.ts          # parseDailyAt / serverTimeZone / nextDailyOccurrence（时区换算）
└── error.ts         # SchedulerError
```

## 已知简化 / TODO

- **仅 daily**：`kind` 恒 `"daily"`；weekly 未来在表上加星期几字段或升级 cron。
- **Dream Gate**：本包不实现；生产环境需由会话层 Runtime 实现并注册到 `memoryDaily`，
  否则自动触发的 Daily 会与活跃 Session 冲突。
- **时区边界**：跨夏令时重合/跳变时刻按近似偏移换算，可能偏移一小时（对无夏令时地区无影响）。

## 示例与测试

```sh
npm run example -w toy-memory-scheduler
npm test -w toy-memory-scheduler
```

示例使用内存 mock 演示配置 / 读取 / 手动扫描 / 关闭调度；测试覆盖钟点解析、到期判断、
阈值放弃、原子触发与多空间各自判断。
