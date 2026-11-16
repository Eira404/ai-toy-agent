# toy-jev-llm

把 JEV 评估请求桥接到 LLM 的适配器插件。它实现 `JevAdapter`，内部调用 `ctx.llm.generate` 并约束结构化输出，从而让 LLM（或其降级链）成为 JEV 的兜底候选。

先挂载 `toy-llm` 和 `toy-jev`，再挂载本包：

```js
import { LlmRuntime } from "toy-llm"
import { OpenAIResponsesPlugin } from "toy-llm-openai-responses"
import { JevRuntime } from "toy-jev"
import { JevTypesafePlugin } from "toy-jev-typesafe"
import { JevLlmPlugin } from "toy-jev-llm"

await ctx.plugin(LlmRuntime)
await ctx.plugin(OpenAIResponsesPlugin, { provider: "dashscope", baseURL, apiKey })
ctx.llm.registerChain("main", [
  { provider: "dashscope", model: "qwen3.7-max" },
  { provider: "dashscope", model: "qwen3.5-flash" },
])

await ctx.plugin(JevRuntime)
await ctx.plugin(JevTypesafePlugin, { provider: "typesafe", baseURL, apiKey })

// 注册「LLM 兜底」JEV 路由；llmProvider 可以是单模型或一条 LLM 降级链。
await ctx.plugin(JevLlmPlugin, { provider: "llm", llmProvider: "main" })

// 组装 JEV 降级链：model 一律在链条目里给，adapter 不持有模型。
ctx.jev.registerChain("jev-main", [
  { provider: "typesafe", model: "jev-1.14.0" },
  { provider: "llm", model: "qwen3.7-max" }, // llmProvider 是链时被覆盖，作占位
])
await ctx.jev.invoke(state, questions, { provider: "jev-main" })
```

要点：

- `llmProvider` 指向单个 LLM 路由或一条 LLM 降级链；model 由 JEV 链条目提供（桥接层再传给 LLM）。
- 桥接层把 JEV 问题翻译成提示词和 JSON Schema，调用 LLM 后解析为 `JevResponse`，最终由 JEV 核心做问题匹配校验。
- LLM 可降级失败会抛 `retryable: true` 的 `JevError`，使 JEV 链可继续；取消、非法输出等不降级。
- 全部失败时错误 `code` 为 `FALLBACK_EXHAUSTED`。

同一 `JevLlmPlugin` 类可通过不同的 `provider` 加载多次，用于不同场景走不同模型/链：

```js
// 简单任务用小模型兜底，复杂任务用大模型兜底
await ctx.plugin(JevLlmPlugin, { provider: "llm-small", llmProvider: "small" })
await ctx.plugin(JevLlmPlugin, { provider: "llm-big", llmProvider: "big-chain" })

ctx.jev.registerChain("simple", [
  { provider: "typesafe", model: "jev-1.14.0" },
  { provider: "llm-small", model: "qwen3.5-flash" },
])
ctx.jev.registerChain("complex", [
  { provider: "typesafe", model: "jev-1.14.0" },
  { provider: "llm-big", model: "qwen3.7-max" },
])

await ctx.jev.invoke(state, simpleQuestions, { provider: "simple" })
await ctx.jev.invoke(state, complexQuestions, { provider: "complex" })
```

从根目录运行 `npm test -w toy-jev-llm`。
