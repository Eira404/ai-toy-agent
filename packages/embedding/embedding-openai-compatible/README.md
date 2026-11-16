# toy-embedding-openai-compatible

为 `toy-embedding` 注册一个 OpenAI 兼容 `/embeddings` 路由。它负责请求序列化、响应解析，以及分块、排序合并、维度校验和 HTTP 错误映射。同一协议天然覆盖 DashScope、OpenAI 等兼容端点。

先挂载 `EmbeddingRuntime`，再挂载本包的 `EmbeddingOpenAICompatiblePlugin`：

```js
import { EmbeddingRuntime } from "toy-embedding"
import { EmbeddingOpenAICompatiblePlugin } from "toy-embedding-openai-compatible"

await ctx.plugin(EmbeddingRuntime)
await ctx.plugin(EmbeddingOpenAICompatiblePlugin, {
  provider: "dashscope",
  baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  apiKey,
  dimensions: 1024,
})
```

调用 `ctx.embedding.embed` 时指定该 `provider` 和模型。可选的 `dimensions` 写入请求体，`batchSize` 控制单次请求的文本上限。失败会保留状态码、请求 ID 和服务提供的重试提示。

同一插件类可通过不同的 `provider` 加载多次，注册多条路由。路由级失败降级见 [`toy-embedding`](../embedding/README.md) 的降级链。

从根目录运行 `npm run build` 构建依赖，再运行 `npm run example -w toy-embedding-openai-compatible` 或 `npm test -w toy-embedding-openai-compatible`。[示例](./examples/basic.mjs) 使用注入的 HTTP 响应。
