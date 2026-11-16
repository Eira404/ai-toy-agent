# 阶段七 · 价值结算与遗忘（settle）

checkpoint stage `8`

**职责**：对每个 APPLY 块的概述与细节计算最终价值 + 生命周期，LOCAL_ABANDON 块收集起来供审计。

**输入**：`FreezeBaseline`（冻结旧 Long）、`ConsolidationResult`（R0）、`VerifyOutcome[]`。

**输出**（checkpoint payload）：`SettlementResult`

```ts
interface SettlementResult {
  settled: SettledBlock[] // APPLY 块：plan + overviewValue/lifecycle + detailValues
  abandoned: BlockChangePlan[] // LOCAL_ABANDON 块
}
```

**依赖**：价值引擎（`settle`/`reinforceUpdated`/`initialize`/`decay`/`max`/`lifecycle`）。

**关键逻辑**（每个价值单元：概述 `overview:{blockId}`、细节 `detail:{detailId}`）：

- **INITIALIZE**（新块概述）→ `decay(initialize(...))`；
- **INHERIT**（已有概述/细节）→ `decay(max(原值, R0, R7))`，其中 `R0` 来自阶段零、`R7` 仅正文变化时 `reinforceUpdated`；
- `lifecycle = engine.lifecycle(final)`。

`reinforceUpdated` 是异步接口；概述与细节均等待语义变化判断完成，再取大、衰减。

**无价值引擎**：INHERIT 透传旧值/旧生命周期；INITIALIZE 写 `NO_VALUE_STATE` + `active`；不衰减不归档。
