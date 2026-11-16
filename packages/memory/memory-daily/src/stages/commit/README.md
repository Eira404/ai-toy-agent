# 阶段八 · 最终验证与原子提交（commit）

checkpoint stage `9`（无 checkpoint，是终点）

**职责**：组装 Long 变更并落库，消费 Fast 与反馈，写审计与空间状态，批次置 succeeded。

**输入**：`FreezeBaseline` + `SettlementResult`。

**输出**：无（返回 `void`）。

**依赖**：Long（`applyChanges`）、Fast（`prepareConsumption` + `applyConsumption`）、
Feedback（`markConsolidated`）、Embedding（summary 向量）。

**关键逻辑**（幂等多步提交，顺序）：
1. **Long 变更**：对每个 settled 块算 summary 向量（block + detail），组装 `LongBlockChange`
   （CREATE/UPDATE + 细节 UPDATE/ARCHIVE），`applyChanges(scope, changeSet, { idempotencyKey: batchId })`；
2. **Fast 消费**：`prepareConsumption` 生成计划 → `applyConsumption` 执行（写 `consumed_batch_id` + 置 done + 删向量）；
3. **反馈消费**：`markConsolidated(scope, batchId, feedbackIds)`；
4. **收尾**：写 audits（APPLY/LOCAL_ABANDON + sourceFastIds）、`space_state.successful_daily_count + 1`、批次置 `succeeded`。

**简化点**：各包各自事务（无跨包真事务）；CREATE 审计的 `target_block_id` 记 null（blockId 由 applyChanges 分配）；
跨进程/跨重启的幂等（batchId 复核）未实现。
