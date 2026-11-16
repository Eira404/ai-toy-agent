# 阶段零 · 记忆巩固价值计算（consolidate-value）

checkpoint stage `1`

**职责**：从冻结反馈中取出「被检索到的价值单元」，连同冻结 Long 里这些单元的当前价值，
逐单元提交给价值引擎 `settle`，得到巩固后的价值（R0），暂存供阶段七取大。

**输入**：`FreezeBaseline`（`frozenLong` 的价值 + `frozenFeedback`）。

**输出**（checkpoint payload）：`ConsolidationResult`

```ts
interface ConsolidationResult {
  reinforced: Readonly<Record<string, ValueState>> // unitKey → R0（仅正向反馈的单元）
  skipped: readonly string[]                       // 反馈引用了但冻结 Long 中不存在的单元键
}
```

**依赖**：价值引擎（`settle`）。无价值引擎时返回空结果（阶段跳过）。

**关键逻辑**：
1. 从冻结 Long 建 `unitKey → ValueState` 索引（块概述 + 各细节）；
2. 按 unitKey 聚合反馈判断（同一单元多 Session 按 createdAt 升序）；
3. 逐单元 `engine.settle(原值, judgements)` → R0。

`unitKey` 格式：`overview:{blockId}` / `detail:{detailId}`（见 `src/unit.ts`）。
