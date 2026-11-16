# 阶段四 · 按目标生成内容（generate）

checkpoint stage `5`

**职责**：按 targetBlockId 聚合候选，每个目标一次内容生成 LLM，产出块内容 + 细节操作。

**输入**：`LongCandidate[]` + `CandidateAssignment[]`。

**输出**（checkpoint payload）：`BlockChangePlan[]`

```ts
type BlockChangePlan =
  | { kind: "CREATE"; domain; title; aliases; summary; overviewBody; sourceFastIds; candidates }
  | { kind: "UPDATE"; blockId; domain; title; aliases; summary; overviewBody; detailOps; sourceFastIds; candidates }

type DetailOp =
  | { kind: "UPDATE"; detailId; summary; body }
  | { kind: "DELETE"; detailId }
```

**依赖**：Long（`getBlock`）、LLM。

**关键逻辑**：
1. 按 `targetBlockId` 聚合（EXISTING 聚合到已有块，NEW 各自临时块）；
2. 每目标一次 LLM：生成 `title/aliases/summary/overviewBody` + `detailOperations`（UPDATE/DELETE）；
3. 程序校验：CREATE 的细节操作必须为空；UPDATE 的 detailId 必须存在且无重复；
4. 附加 `sourceFastIds`（组内并集）+ `candidates`（供阶段六验证）。

**简化点**：不支持细节 CREATE / MOVE / SPLIT（只 UPDATE/DELETE）。
