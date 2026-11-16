# JEV

结构化评估（`choice` / `score` / `noul`）调用栈：一个核心服务 `toy-jev`，加上 TypeSafe 适配器与 LLM 桥接兜底。

## 包

- [`toy-jev`](./jev/README.md) — 核心：挂载到 `ctx.jev`，Schema 校验、答案匹配、命名路由与失败降级链（`registerChain`）。
- [`toy-jev-typesafe`](./jev-typesafe/README.md) — TypeSafe HTTP 适配器（`JevTypesafePlugin`）。
- [`toy-jev-llm`](./jev-llm/README.md) — LLM 桥接兜底（`JevLlmPlugin`），让 LLM（或其降级链）成为 JEV 的降级候选。

## 组合方式

先挂载核心，再挂载适配器插件，之后业务只通过 `ctx.jev` 调用：

```js
import { JevRuntime } from "toy-jev"
import { JevTypesafePlugin } from "toy-jev-typesafe"
import { JevLlmPlugin } from "toy-jev-llm"

await ctx.plugin(JevRuntime)
await ctx.plugin(JevTypesafePlugin, { provider: "typesafe", baseURL, apiKey })

// main 是一条 LLM 降级链：typesafe 失败时自动走 LLM 兜底；model 在链条目里给
await ctx.plugin(JevLlmPlugin, { provider: "llm", llmProvider: "main" })
ctx.jev.registerChain("jev-main", [
  { provider: "typesafe", model: "jev-1.14.0" },
  { provider: "llm", model: "qwen3.7-max" },
])
```

不同场景可以用不同 LLM 兜底（小模型/大模型），见 [`toy-jev-llm`](./jev-llm/README.md)。
