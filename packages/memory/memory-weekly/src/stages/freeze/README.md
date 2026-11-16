# 冻结与修改集（freeze）

checkpoint stage `0`

**职责**：读取前置 Daily 刚提交的最新 Long，转成可变快照，并按 `contentUpdatedAt > lastWeeklyAt` 计算修改集。

**输入**：无（`frozenLong` 来自 `long.freezeSnapshot`；`lastWeeklyAt` 由 service 从 daily 的 space_state 读入）。

**输出**（checkpoint payload）：`WeeklyFreezeBaseline`

```ts
interface WeeklyFreezeBaseline {
  frozenLong: LongBlock[]          // active + observing，含 value + contentUpdatedAt
  snapshot: WeeklySnapshotBlock[]  // 可变快照，供 split/reclassify/merge/rename 变换
  modifiedBlockIds: string[]       // contentUpdatedAt > lastWeeklyAt（lastWeeklyAt null → 全部）
  lastWeeklyAt: string | null
}
```

**依赖**：Long（`freezeSnapshot`）、快照构建（`buildSnapshot`）。

**关键逻辑**：

1. `long.freezeSnapshot(scope)` 读全部 active + observing Long；
2. `buildSnapshot(frozenLong)` 转成带 `sourceKeys` 的可变快照：
   - overview 的 `overviewSourceKeys = ["overview:{blockId}"]`；
   - detail 的 `sourceKeys = ["detail:{detailId}"]`；
3. 按 `contentUpdatedAt > lastWeeklyAt` 过滤修改集；`lastWeeklyAt === null`（首次 Weekly）时全部算修改。

**简化点**：turn 活动阈值未接入，防饥饿判定只依赖 `successfulDailyCount >= N`（在 service 里）。
