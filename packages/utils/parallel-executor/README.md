# toy-parallel-executor

Cordis 命名任务池插件。一个完整任务从开始到函数退出一直占用一个池名额，适用于 Session 整理、候选归属、内容生成、价值判断等异步流程。池不绑定模型，也不创建 CPU 工作线程。

服务入口为 **`ctx.parallelExecutor`**。Cordis 已有 `ctx.parallel()` 事件 API，因此不覆盖该名称。业务统一经插件调用，内部执行器不作为包入口导出。

## 可运行示例

在仓库根目录运行，命令会先构建本包。示例全部在本地运行，不需要数据库、模型服务或 API Key。

| 命令                                               | 文件                                         | 演示内容                                             |
| -------------------------------------------------- | -------------------------------------------- | ---------------------------------------------------- |
| `npm run example -w toy-parallel-executor`         | [examples/basic.mjs](examples/basic.mjs)     | 注册插件和池、run、有序 map、mapSettled、统计和卸载  |
| `npm run example:pools -w toy-parallel-executor`   | [examples/pools.mjs](examples/pools.mjs)     | 共享池上限、运行中覆盖配置、队列保留、跨池与同池嵌套 |
| `npm run example:control -w toy-parallel-executor` | [examples/control.mjs](examples/control.mjs) | 整任务重试、执行超时、外部取消、未启动项目的结果     |

各示例包含断言，输出实际结果；断言失败时进程返回非零退出码。

## 注册插件和任务池

```ts
import { Context } from "cordis"
import { ParallelExecutor } from "toy-parallel-executor"

const ctx = new Context()
const fiber = await ctx.plugin(ParallelExecutor)

ctx.parallelExecutor.registerPool("memory-daily", {
  maxConcurrency: 8,
  maxQueueSize: 200,
  queueTimeoutMs: 30_000,
  attemptTimeoutMs: 300_000,
  retry: false,
})

ctx.parallelExecutor.registerPool("memory-value", {
  maxConcurrency: 4,
})
```

也可以在插件初始化时提供 `pools`。依赖插件通过 `static inject = ["parallelExecutor"]` 声明依赖。

```ts
await ctx.plugin(ParallelExecutor, {
  defaultMapConcurrency: 4,
  pools: {
    work: { maxConcurrency: 8 },
  },
})
```

所有池在同一个服务实例中共享，多个调用方或批次使用同名池时共同遵守该池上限。不同池相互独立；不同进程、不同服务实例之间不共享额度。任务池不提供 RPM/TPM 限流或任务持久化。

## 配置参数

插件配置：

| 参数                    | 默认值 | 含义                                                 |
| ----------------------- | ------ | ---------------------------------------------------- |
| `defaultMapConcurrency` | `4`    | 未指定批次并发时使用，实际默认值取它与池上限的较小值 |
| `pools`                 | `{}`   | 池名到 `TaskPoolConfig` 的映射，可稍后动态注册       |

`TaskPoolConfig`：

| 参数               | 默认值  | 含义                                     |
| ------------------ | ------- | ---------------------------------------- |
| `maxConcurrency`   | 必填    | 所有批次合计最多同时执行多少个任务       |
| `maxQueueSize`     | `1000`  | 等待池名额的任务数上限，允许 `0`         |
| `queueTimeoutMs`   | `30000` | 每次排队的最长等待时间，`null` 为不限    |
| `attemptTimeoutMs` | `null`  | 一次完整任务尝试的取消期限               |
| `totalTimeoutMs`   | `null`  | 单任务总预算，包含排队、执行、退避及重试 |
| `retry`            | `false` | 整任务重试策略，详见下文                 |

并发数要求正安全整数，队列长度要求非负安全整数。超时与退避时间为正整数毫秒，最大 `2147483647`；禁用超时使用 `null`，不使用 `0`。池名去除首尾空白，不能为空。

### 同名注册覆盖

```ts
ctx.parallelExecutor.registerPool("memory-daily", {
  maxConcurrency: 2,
  maxQueueSize: 50,
})
```

覆盖采用**完整替换**：未提供的配置回到默认值，例如上例 `attemptTimeoutMs` 回到 `null`。配置校验失败不影响原池。配置及重试对象会被复制，注册后修改原对象不影响服务。

同名覆盖保留同一个池的队列、运行计数和累计统计：

- 提高并发上限，立即按新上限派发等待任务。
- 降低并发上限，不中断运行任务；运行数低于新上限后再派发。
- 降低队列上限，不驱逐已有排队项，后续提交按新上限判定。
- 已提交任务保留原超时和重试策略，包括它的后续重试。
- 批次尚未提交的后续项目读取新的池默认值，但显式 `options.task` 仍优先。

任务池由执行器服务管理，注册者卸载不自动删除池。首版没有删除或恢复旧版本配置的接口。

## run：单个完整任务

```ts
const value = await ctx.parallelExecutor.run(
  async ({ signal, attempt, taskId }) => {
    signal.throwIfAborted()
    // 使用 signal 取消模型、网络或其他协作式异步操作。
    return { taskId, attempt, result: 42 }
  },
  {
    pool: "memory-daily",
    taskId: "candidate-1",
    batchId: "daily-1:assign",
    name: "daily.assign",
    attemptTimeoutMs: 120_000,
    retry: false,
  },
)
```

签名：`run<R>(task, options: RunOptions): Promise<R>`。同步结果、同步抛错和异步结果均支持。必须提供尚未执行的函数，不能传入已启动的 Promise。任务返回值不作业务判断；返回 `{ error: ... }` 仍是成功，业务失败应抛异常。

`RunOptions`：

| 参数               | 默认值    | 含义                                       |
| ------------------ | --------- | ------------------------------------------ |
| `pool`             | 必填      | 已注册池名                                 |
| `taskId`           | 自动 UUID | 关联任务，不保证去重或幂等                 |
| `batchId`          | 无        | 关联业务批次，仅作为元数据                 |
| `name`             | 无        | 业务操作名，透传到任务上下文               |
| `signal`           | 无        | 外部取消信号，嵌套调用还自动继承父任务取消 |
| `queueTimeoutMs`   | 池默认    | 覆盖本任务的排队期限                       |
| `attemptTimeoutMs` | 池默认    | 覆盖本任务单次尝试期限                     |
| `totalTimeoutMs`   | 池默认    | 覆盖本任务总预算                           |
| `retry`            | 池默认    | 完整替换重试对象；`false` 禁用             |

任务上下文 `TaskContext` 包含 `pool`、`taskId`、可选 `batchId/name`、从 `1` 开始的 `attempt` 和合并后的 `signal`。

## map：有序严格批次

```ts
const output = await ctx.parallelExecutor.map(
  ["session-1", "session-2", "session-3"],
  async (sessionId, task) => {
    task.signal.throwIfAborted()
    return { sessionId, index: task.index }
  },
  {
    pool: "memory-daily",
    concurrency: 4,
    batchId: "daily-1:consolidate-session",
    name: "daily.consolidate-session",
    batchTimeoutMs: 900_000,
    task: { attemptTimeoutMs: 180_000, retry: false },
  },
)
```

签名：`map<T, R>(items, worker, options: MapOptions): Promise<R[]>`。

| 参数             | 默认值                               | 含义                               |
| ---------------- | ------------------------------------ | ---------------------------------- |
| `pool`           | 必填                                 | 本批每项进入的任务池               |
| `concurrency`    | `min(defaultMapConcurrency, 池上限)` | 本批排队、运行、退避中的项目数上限 |
| `batchId`        | 自动 UUID                            | 项目 ID 为 `${batchId}:${index}`   |
| `name`           | 无                                   | 本批任务的业务操作名               |
| `signal`         | 无                                   | 取消整个批次                       |
| `batchTimeoutMs` | `null`                               | 整批预算，包含未提交项目的等待     |
| `task`           | `{}`                                 | 每项提交时覆盖池的超时及重试默认值 |

每个 worker 收到 `MapTaskContext`：包含 `TaskContext` 全部字段，以及必有的 `batchId` 和输入位置 `index`。结果顺序只由输入位置决定。

池的硬上限与批次并发同时生效。池上限为 `8`、本批并发为 `4` 时，本批最多推进四项；另一批最多占用剩余名额。一个大批次逐步提交，尚未提交的输入不占池队列；其输入数组会浅复制，元素对象不深拷贝。

任一项目最终失败，严格批次停止派发、移除同批排队项、取消在途任务，等待它们退出后抛 `ParallelBatchError`。已完成的副作用不回滚。空数组返回 `[]`，但仍校验池和调用参数。预取消的严格批次直接拒绝。

## mapSettled：保留逐项结果

参数与 `map` 完全相同，签名为 `mapSettled<T, R>(items, worker, options): Promise<TaskResult<R>[]>`。

```ts
const results = await ctx.parallelExecutor.mapSettled(
  [1, 2, 3],
  (value) => {
    if (value === 2) {
      throw new Error("该项失败")
    }
    return value * 2
  },
  { pool: "memory-value", concurrency: 2 },
)

for (const item of results) {
  if (item.status === "fulfilled") {
    console.log(item.index, item.value)
  } else if (item.status === "rejected") {
    console.error(item.index, item.error)
  } else {
    console.log(item.index, item.attempts, item.reason)
  }
}
```

每项都有 `taskId/index/attempts`，状态为 `fulfilled`（含 `value`）、`rejected`（含 `error`）或 `cancelled`（含 `reason`）。普通失败和队列满只影响该项，剩余项目继续。外部取消、父取消、批次超时或插件关闭才取消整批；尚未开始的项目 `attempts` 为 `0`，返回数组仍完整且有序。

单任务自身超时属于该项失败，不自动取消整个 settled 批次。参数错误、未知池和非法嵌套直接拒绝调用，不伪装成项目结果。

## 取消与超时

`signal` 合并外部取消、父任务取消、超时和插件关闭。任务必须向底层透传该信号。

超时只发出协作式取消：**函数未退出前，不释放运行名额、不完成收尾，也不启动重叠重试**。忽略信号的函数可能令返回时间超过期限，甚至一直无法收尾；执行器无法强制终止任意函数。同步 CPU 工作也无法被计时器抢占。

排队超时不执行任务；单次尝试超时可由重试策略决定是否重试；总超时包含所有等待并终止重试。`null` 只关闭执行器对应超时，不关闭底层自己的超时。

## 整任务重试

```ts
ctx.parallelExecutor.registerPool("background", {
  maxConcurrency: 2,
  retry: {
    maxAttempts: 3,
    shouldRetry: (error) => error instanceof Error && error.message === "temporary",
    baseDelayMs: 500,
    maxDelayMs: 10_000,
    jitter: true,
    // retryAfterMs: (error) => 从结构化业务错误提取服务端等待时间,
  },
})
```

`RetryPolicy` 中 `maxAttempts`（含首次）和 `shouldRetry(error, { pool, taskId, attempt })` 必填。`baseDelayMs` 默认 `500`、`maxDelayMs` 默认 `10000` 且不得小于初始间隔；`jitter` 默认 `true`；`retryAfterMs(error)` 可选，返回非负有限毫秒数。

第 n 次失败的退避上限为 `min(maxDelayMs, baseDelayMs * 2 ** (n - 1))`；启用抖动时从零到上限取随机整数，实际计时最少 `1ms`。如有服务端等待要求，取两者较大值（允许超过退避上限，但不得超过计时器范围）。总预算可随时中止等待。

退避期间释放池名额，但仍占本批的一项并发额度；等待结束重新入队。队列满、排队超时、取消、总超时、关闭均不调用 `shouldRetry`。策略函数抛错或返回无效间隔会终止任务。

重试重新执行**整个回调**，其内部已经完成的工作也会重复。涉及写入时由业务保证幂等；默认不重试。

## 嵌套任务

普通函数调用不额外申请名额。通过插件提交子任务时，允许不同池嵌套，并自动继承父任务取消。插件在异步调用上下文中跟踪仍在执行的父任务池链：同池嵌套以及 `A → B → A` 在入队前报 `POOL_REENTRY`，防止等待自身的池名额。

```ts
await ctx.parallelExecutor.run(
  () => ctx.parallelExecutor.map([1, 2], (value) => value * 2, { pool: "memory-value" }),
  { pool: "memory-daily" },
)
```

父任务等待子任务期间仍占父池名额。必须 await 子任务，让任务函数的生命周期覆盖其工作。主流程若内部使用 `memory-daily` 批次，则主流程自身不能再套一层同池 `run`。不要在任务内部等待全局 `waitForIdle()`，它也会等待当前任务自身。

## 错误、统计和生命周期

`ParallelError` 包含 `code/taskId/batchId/pool/attempts/cause`。代码为 `INVALID_OPTIONS`、`UNKNOWN_POOL`、`QUEUE_FULL`、`QUEUE_TIMEOUT`、`ATTEMPT_TIMEOUT`、`TOTAL_TIMEOUT`、`CANCELLED`、`SERVICE_CLOSED`、`TASK_FAILED`、`POOL_REENTRY`。

`ParallelBatchError` 继承它，并增加首个失败的输入 `index`，`cause` 保留该任务错误。没有任何项启动的批次取消可直接抛 `ParallelError`。

```ts
ctx.parallelExecutor.hasPool("memory-daily")
ctx.parallelExecutor.stats()
ctx.parallelExecutor.stats("memory-daily")
await ctx.parallelExecutor.waitForIdle()
```

`stats(pool?)` 返回独立快照：`activeBatches` 为全局未收尾批次数；`pools` 为全部或指定池的统计。各池包括：

- 当前 `maxConcurrency/maxQueueSize/running/queued/retryWaiting`。
- 从服务启动以来累计的逻辑任务 `submitted/succeeded/failed/cancelled`，以及含重试的 `attemptsStarted`。
- 通过调用校验后提交即计入 `submitted`，包括队列满；未提交的批次项目不计入。任务总/单次超时计为失败，外部取消及关闭计为取消。覆盖池配置不清空统计。

`waitForIdle({ signal? })` 等待当前服务所有批次、排队、运行、退避任务清空。取消该等待不取消任务。先停止业务入口和任务生产方，再等待业务流程及执行器空闲，最后卸载：

```ts
await ctx.parallelExecutor.waitForIdle()
await fiber.dispose()
```

直接卸载插件则停止接收任务，取消所有排队、退避和在途任务，等待任务函数退出后完成卸载。服务不持久化任务，不自动覆盖 CPU 或跨进程资源配额。

## 验证

在仓库根目录运行：

```powershell
npm test -w toy-parallel-executor
npm run typecheck -w toy-parallel-executor
npx eslint packages/utils/parallel-executor
npx prettier packages/utils/parallel-executor --check
```
