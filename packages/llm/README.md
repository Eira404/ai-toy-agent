# LLM

通用大模型调用栈：一个供应商无关的核心服务 `toy-llm`，加上把不同供应商协议翻译成统一流的适配器插件。

## 包

- [`toy-llm`](./llm/README.md) — 核心：挂载到 `ctx.llm`，统一消息/内容块/流协议、命名路由（`registerAdapter`）与失败降级链（`registerChain`）。
- [`toy-llm-openai-responses`](./llm-openai-responses/README.md) — Responses API 适配器（`OpenAIResponsesPlugin`）。
- [`toy-llm-openai-compatible`](./llm-openai-compatible/README.md) — Chat Completions 适配器（`OpenAICompatiblePlugin`）。

## 组合方式

先挂载核心，再挂载适配器插件，之后业务只通过 `ctx.llm` 调用：

```js
import { LlmRuntime } from "toy-llm"
import { OpenAIResponsesPlugin } from "toy-llm-openai-responses"

await ctx.plugin(LlmRuntime)
await ctx.plugin(OpenAIResponsesPlugin, { provider: "dashscope", baseURL, apiKey })
```

多个 provider 可注册，也可以组成一条失败自动降级的链，见 [`toy-llm` 的降级链](./llm/README.md)。
