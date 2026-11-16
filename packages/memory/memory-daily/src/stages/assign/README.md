# 阶段三 · Long 候选归属（assign）

checkpoint stage `4`

**职责**：对每条 Long 候选判断唯一 Domain，三路召回已有块，筛出相关块，再由 LLM 定唯一目标。

**输入**：`LongCandidate[]`。

**输出**（checkpoint payload）：`CandidateAssignment[]`

```ts
interface CandidateAssignment {
  candidateId: string
  domain: LongDomain             // self/person/project/topic/entity/event
  targetKind: "EXISTING" | "NEW"
  targetBlockId: string          // EXISTING=已有 blockId；NEW=临时 new-{candidateId}
}
```

**依赖**：JEV（可选）、Embedding、Long（`listBlocksByDomain`/`recallBySummary`/`getBlock`）、LLM。

**关键逻辑**（每条候选）：
1. JEV 判 Domain（无 JEV 降级 `self`）+ Embedding 算 summary 向量（并行）；
2. **三路召回**该 Domain 已有块：title/alias 完全匹配 + summary 向量（topK≤21）+ 随机（≤42 去重，优先级 title > vector > random）；
3. JEV 逐块筛 `POSSIBLY_RELATED`（无 JEV 时跳过，全部交给 LLM）；
4. 无相关块 → 直接 NEW；有 → LLM 输出 `{kind:"EXISTING",blockId}` 或 `{kind:"NEW"}`。

**简化点**：随机召回用 `Math.random`（种子不持久化）、title 召回只做完全匹配（不含双向包含）、同批新建目标对齐（12.5.5）未实现。
