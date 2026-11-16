# 阶段六 · 独立验证与局部放弃（verify）

checkpoint stage `7`

**职责**：每个变化块独立验证，过滤由裁切导致的 MISSING，有剩余问题则修正一轮并重新验证，仍失败则局部放弃。

**输入**：`CapacityOutcome[]`（含 `plan` + `truncatedFields`）。

**输出**（checkpoint payload）：`VerifyOutcome[]`

```ts
interface VerifyOutcome {
  verdict: "APPLY" | "LOCAL_ABANDON"
  plan: BlockChangePlan   // APPLY=最终方案；LOCAL_ABANDON=原方案（供审计）
}
```

**依赖**：Long（`getBlock`）、LLM（验证 + 修正）。

**关键逻辑**（每块）：
1. **验证 LLM**：读取冻结旧块（UPDATE）+ 来源候选 + 模拟块 → `PASS` 或问题列表（CONTRADICTED/UNSUPPORTED/MISSING/DUPLICATED/MISPLACED/INVALID_ALIAS/MISLEADING_TITLE/MISLEADING_SUMMARY）；
2. 过滤由 `truncatedFields` 导致的 MISSING；
3. 有剩余问题 → **修正 LLM** 重新生成完整块 → 再验证；
4. 仍失败 → `LOCAL_ABANDON`（已有块恢复旧内容、新块取消）。

**简化点**：最多一轮修正（v2 是两轮）；修正后未回容量整理。
