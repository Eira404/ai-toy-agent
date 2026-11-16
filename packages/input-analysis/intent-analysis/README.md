# toy-intent-analysis

意图分类预处理插件，向 Agent Loop 的 preprocessing 注册名为 `intent` 的节点。默认走 LLM，可显式
切换 JEV。

```ts
await ctx.plugin(ToyIntentAnalysis, { provider: "openai", model: "gpt-4o-mini" })
```

结果 `{ intent, confidence }` 进入 `preprocessing.data.intent`，由 system prompt 组装注入模型。
加载顺序：`toy-llm`（或 `toy-jev`）→ `toy-agent-loop` → `toy-intent-analysis`。

意图目录 `INTENT_CATALOG` 与输入/输出 Schema 从本包导出，新增意图只维护 `intent-catalog.ts`。
