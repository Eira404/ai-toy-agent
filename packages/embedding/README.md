# Embedding

向量嵌入调用栈：一个核心服务 `toy-embedding`，加上 OpenAI 兼容 `/embeddings` 适配器。

## 包

- [`toy-embedding`](./embedding/README.md) — 核心：挂载到 `ctx.embedding`，批量嵌入、维度校验、命名路由与失败降级链（`registerChain`）。
- [`toy-embedding-openai-compatible`](./embedding-openai-compatible/README.md) — OpenAI 兼容 `/embeddings` 适配器（`EmbeddingOpenAICompatiblePlugin`）。

## 组合方式

先挂载核心，再挂载适配器插件，之后业务只通过 `ctx.embedding` 调用：

```js
import { EmbeddingRuntime } from "toy-embedding"
import { EmbeddingOpenAICompatiblePlugin } from "toy-embedding-openai-compatible"

await ctx.plugin(EmbeddingRuntime)
await ctx.plugin(EmbeddingOpenAICompatiblePlugin, { provider: "dashscope", baseURL, apiKey })
```

多个 provider 可注册，也可以组成一条失败自动降级的链，见 [`toy-embedding` 的降级链](./embedding/README.md)。
