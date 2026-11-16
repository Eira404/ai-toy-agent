# toy-memory-feedback

记忆价值反馈插件。它在 Session 收尾时调用「价值系统」判断每个召回记忆单元的态度，把结果落库，供 Daily Dream 巩固时消费。

本包**不内置**态度判断逻辑，也不计算价值数值；它只负责编排与持久化。态度判断和价值数值由「价值系统插件」实现，通过 `registerValueEngine` 注入。

## 职责边界

| 环节                                 | 谁负责                                                 |
| ------------------------------------ | ------------------------------------------------------ |
| 记录「哪轮检索召回了哪些记忆及正文」 | `memory_read` 工具（随 `tool_result.data.units` 落库） |
| 从 event 提取召回记录与对话          | 提取插件（照本包定义的输入契约转换）                   |
| 判断每个价值单元的态度 + 临时数据    | 价值系统插件（`ValueEngine.judgeSession`）             |
| 巩固时的价值数值计算                 | 价值系统插件（`ValueEngine.settle` / `initialize`）    |
| 编排 + 落库 + 供 Daily 读取          | 本包                                                   |

## 挂载

先挂载 `toy-storage`、`toy-storage-relational` 和数据库 adapter（用 `feedbackRelationalSchema`），再挂载本包。用数据库时由宿主把 `feedbackRelationalSchema.tables` 合并进命名数据源。

```ts
import { Context } from "cordis"
import { ToyStorage } from "toy-storage"
import { RelationalStorage } from "toy-storage-relational"
import { MemoryFeedback, feedbackRelationalSchema } from "toy-memory-feedback"

const ctx = new Context()
await ctx.plugin(ToyStorage)
await ctx.plugin(RelationalStorage)
// 这里挂载具体数据库 adapter，schema 使用 feedbackRelationalSchema
await ctx.plugin(MemoryFeedback, { sourceName: "main" })
```

## 注册价值系统

```ts
await ctx.plugin({
  name: "my-value-engine",
  inject: ["memoryFeedback"],
  apply(inner) {
    inner.effect(() =>
      inner.memoryFeedback.registerValueEngine({
        async judgeSession(input) {
          // input.recalledContent：首次召回正文；input.recallSnapshots：每次召回的完整快照
          // 返回 { feedbackType, evidenceTurnNos, judgementData, judgementVersion }
        },
      }),
    )
  },
})
```

同一服务只允许注册一个价值系统；重复注册抛 `engine-already-registered`。

## 方法

### `settleSessionFeedback(input)`

Session 收尾：为每个召回价值单元调用 `judgeSession` 并落库。幂等（重复收尾复用原记录，不重复调用价值系统）。

输入契约（提取插件照此从 Session event 转换）：

```ts
{
  userId, memorySpaceId, sessionId,
  recalls: [{ turnNo, turnId, units: [{
    unitType: "overview", unitId: blockId, blockId,
    recalledContent: { title, summary, overviewBody },
  }, {
    unitType: "detail", unitId: detailId, blockId,
    recalledContent: { summary, body },
  }] }],
  conversation: [{ turnNo, userText, assistantText }],
}
```

返回 `FeedbackOutcome[]`，即该 Session 每个去重价值单元的一条反馈。

`RecallUnit` 是工具生产方和 feedback 共用的类型。`recalledContent` 用 `Pick` 直接复用
`LongBlockHit` / `LongDetailHit` 的正文字段：overview 保留 `overviewBody`，detail 保留
`summary` / `body`，与 `memory_read` 返回模型的正文字段一致。Fast 不参与价值反馈。
提取时直接使用工具事件保存的 `data.units`，不要收尾时重新查询当前 Long。

传给 `judgeSession` 时，`recalledContent` 是最早召回的正文；`recallSnapshots` 按 Turn
升序保留所有召回快照（含 `turnNo` / `turnId`），避免同一单元的后续正文覆盖前面的语境。
`recallAssistantTurns` 提供各召回轮的助手回答，仅作语境参考；`relevantTurns` 仍严格是
首次召回之后的对话，用户态度证据从中选择。`signal` 继续透传。

旧的仅含 ID 的召回记录会报 `invalid-input`，不会用缺失的正文调用引擎。Session 收尾
自动提取插件尚未接入；宿主当前需将 `tool_result.data.units` 与事件所属 Turn 信息组装为
`RecallEntry`，再调用本服务。

### `listPending(scope)`

读取某空间所有尚未巩固（`consumed_batch_id IS NULL`）的反馈，供 Daily 冻结输入。

### `markConsolidated(scope, batchId, feedbackIds)`

把一批反馈标记为已被某个 Daily 批次巩固。幂等：只影响尚未巩固的反馈。

### `registerValueEngine(engine)`

注册唯一价值系统，返回注销函数。

## 数据表

`toy_memory_feedback_entries`：每行是「一个 Session 内一个价值单元的一条反馈」。

唯一索引 `(memory_space_id, session_id, unit_type, unit_id)` 保证同 Session 同单元只有一条反馈。`judgement_data` 是价值系统的临时判断，`judgement_version` 标识其格式。

## 示例与测试

从仓库根目录运行：

```sh
npm run example -w toy-memory-feedback
npm test -w toy-memory-feedback
```

完整示例见 [examples/basic.mjs](examples/basic.mjs)，测试见 [test/feedback.test.mjs](test/feedback.test.mjs)。二者都使用内存关系型 adapter，无需数据库。
