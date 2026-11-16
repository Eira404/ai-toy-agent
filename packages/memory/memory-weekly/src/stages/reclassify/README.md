# 阶段二 · RECLASSIFY（reclassify）

checkpoint stage `2`

**职责**：只把「当前 Domain 明显错误」的块移到唯一清晰的目标 Domain；不拆分、不合并、不改正文、不改价值。

**输入**：`snapshot`（split 后快照）+ `modifiedBlockIds`。

**输出**（checkpoint payload）：`WeeklySnapshotBlock[]`（换域块的 `domain` 变化、`ops` 追加 `"RECLASSIFY"`，其余字段原样）。

**依赖**：JEV（可选；无 JEV 时整体跳过，保持原 Domain）。

**关键逻辑**（只遍历修改集）：

1. 无 JEV → 返回原快照；
2. 对每个修改块做**双重 JEV 判断**：
   - 第一问 `KEEP_CURRENT` / `CLEARLY_MISCLASSIFIED`；
   - 仅 `CLEARLY_MISCLASSIFIED` 才问第二问：其它五个 Domain 或 `NO_CLEAR_TARGET`；
3. 两问都通过（第一问 `CLEARLY_MISCLASSIFIED` 且第二问返回一个不同、合法的 Domain）才改 `domain`；
   - `NO_CLEAR_TARGET` 保持原 Domain；非法输出抛 `WeeklyMemoryError`。

**失败边界**：任一 JEV 调用返回非法结构或未知选项即抛错，由上层按 `weeklyStageMaxAttempts` 阶段内重试，不把失败降级为 `KEEP_CURRENT`。

**简化点**：`RECLASSIFY_SKIPPED_TOO_LARGE`（单个完整块超过 JEV 输入容量时保持原 Domain）未实现。
