# 阶段五 · 模拟执行与容量整理（capacity）

checkpoint stage `6`

**职责**：对变化方案做容量整理——overview 超限时重新分配（核心留 overview、非核心移 detail），detail 超限时重写/拆分，最后处理短字段。

**输入**：`BlockChangePlan[]`。

**输出**（checkpoint payload）：`CapacityOutcome[]`

```ts
interface CapacityOutcome {
  plan: BlockChangePlan       // detailOps 可能是 UPDATE / DELETE / CREATE
  truncatedFields: readonly string[]  // 被程序兜底裁切的字段标识（供阶段六忽略裁切导致的 MISSING）
}
```

**依赖**：LLM（仅超阈值字段时调用）。

**容量阈值**（LLM 目标 / 程序硬阈值）：overview body 300/400、title 40/60、summary 80/100、detail body 250/350、detail summary 50/70。

**关键逻辑（两遍）**：

1. **第一遍 · overview 溢出**：overview body ≥ 硬阈值 → LLM 读 overview + 全部已有 detail，输出精简后的 overview（< 目标）+ 移出内容的 detail 操作：
   - `UPDATE_EXISTING_DETAIL(detailId, summary, body)`：并入同子主题的已有 detail；
   - `CREATE_FROM_OVERVIEW(summary, body)`：新建 detail。
   - 一次可产出多条；仍超限收紧到 250 重试一次，再超程序截断。
2. **第二遍 · detail 超限**：变化的 detail body ≥ 硬阈值 → UPDATE 的走 LLM：
   - `REWRITE(detailId, summary, body)`：去重复、重新概括；
   - `SPLIT(detailId, parts[])`：按子主题/时间/经历边界拆成多条（原 detailId 留一条，其余新建）。
   - CREATE 的直接截断；仍超限收紧到 200 重试，再超截断。
3. **短字段**：title / summary / detail summary 超限时单独压缩（`shorten`），仍超截断。

**简化点**：CREATE detail 超限只截断、不走 REWRITE/SPLIT（因尚无真实 detailId）；title/summary 仍单次压缩（无两遍收紧）。

> 注意：本包容量阈值与 `toy-memory-long` 的配置默认（title 30/40、summary 80/120、detail body 300/400、detail summary 40/60）尚未完全统一。
