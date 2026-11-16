# 冻结（freeze）

checkpoint stage `0`

**职责**：读取本批待处理的 Fast、反馈与当前 Long 快照，形成冻结基线。

**输入**：无（通过 `StageEnv` 的服务读取）。

**输出**（checkpoint payload）：`FreezeBaseline`

```ts
interface FreezeBaseline {
  fastRecords: readonly FastRecord[]     // 待处理 Fast 全文
  sessionIds: readonly string[]          // Fast 来源 Session（去重）
  turnCount: number                      // 可处理 Turn 数（暂恒 0）
  frozenLong: readonly LongBlock[]       // 当前 active + observing 的 Long
  frozenFeedback: readonly FeedbackOutcome[] // 待巩固反馈
  decayEnabled: boolean                  // 是否推进衰减周期（暂恒 true）
}
```

**依赖**：`memoryFast.listPendingForDaily`、`memoryLong.freezeSnapshot`、`memoryFeedback.listPending`（无模型调用）。

**关键逻辑**：三路并行读取后组装基线。假设调用时 Gate 已 LOCKED（无进行中 Session），因此读到的即本次可处理全部输入。

**简化点**：`turnCount` 恒 0、`decayEnabled` 恒 true（活动阈值未接）。
