# 阶段二 · 跨 Session 整理（consolidate-cross）

checkpoint stage `3`

**职责**：把 Session 候选跨 Session 分组，判断哪些可能描述同一对象/主题，再逐组整合成 Long 候选。

**输入**：`SessionCandidate[]`。

**输出**（checkpoint payload）：`LongCandidate[]`

```ts
interface LongCandidate {
  candidateId: string             // 本批唯一（阶段二/三期间有效）
  title: string
  summary: string
  body: string
  candidateTime: string           // 组内最晚 candidateTime
  sourceFastIds: readonly string[] // 组内并集
}
```

**依赖**：LLM（分组 + 组内整合两次调用）。

**关键逻辑**：
1. 给每条候选分配 `candidateId`；
2. **分组 LLM**（只吃 `candidateId + title + summary`）→ `{ groups: [{candidateIds}] }`；
3. 程序校验分组是完整分区（不重不漏、无额外 ID）；
4. 逐组**内容整合 LLM**（title/summary/body/candidateTime）→ 新的 title/summary/body，附加 `candidateTime` + `sourceFastIds` 并集 + 新 `candidateId`。

**简化点**：分组/整合各调一次；超容量的切分与两轮归并未实现。
