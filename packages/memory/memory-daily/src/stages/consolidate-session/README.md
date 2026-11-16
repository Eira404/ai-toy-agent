# 阶段一 · Session 内整理（consolidate-session）

checkpoint stage `2`

**职责**：把冻结 Fast 按 sessionId 分组，每组交给 LLM 整合成一条或多条候选。

**输入**：`FreezeBaseline.fastRecords`。

**输出**（checkpoint payload）：`SessionCandidate[]`

```ts
interface SessionCandidate {
  title: string
  summary: string
  body: string
  candidateTime: string          // 该组最晚 createdAt
  sourceFastIds: readonly string[] // 该组全部 Fast ID（粗粒度来源）
}
```

**依赖**：LLM（`ctx.llm.generate`，`responseFormat: json_schema`）。

**关键逻辑**：按 sessionId 分组 → 每组按 createdAt 升序拼 `Time/Title/Summary/Body` →
LLM 输出 `{ memories: [{title,summary,body}] }` → 程序附加 `candidateTime` + `sourceFastIds`。

**简化点**：每个 Session 作为一组直接处理；超容量时的「相似度分组 + 最多两轮归并」未实现。
