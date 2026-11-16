# toy-llm-openai-compatible

为 `toy-llm` 注册一个 Chat Completions 路由。它负责 HTTP 请求序列化、SSE 分帧和文本、推理、工具调用及用量的转换。工具参数按原始字符串保留，由工具执行层校验。

先挂载 `LlmRuntime`，再挂载本包的 `OpenAICompatiblePlugin`：

```js
import { LlmRuntime } from "toy-llm"
import { OpenAICompatiblePlugin } from "toy-llm-openai-compatible"

await ctx.plugin(LlmRuntime)
await ctx.plugin(OpenAICompatiblePlugin, {
  provider: "dashscope",
  baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  apiKey,
})
```

调用 `ctx.llm.generate` / `ctx.llm.stream` 时指定该 `provider` 和模型。可选的 `timeoutMs` 与调用方信号一起控制请求及读取；`enableThinking` / `thinkingBudget` / `toolStream` 控制推理与工具流的默认值。失败会保留状态码、请求 ID 和服务提供的重试提示。

同一插件类可通过不同的 `provider` 加载多次，注册多条路由。路由级失败降级见 [`toy-llm`](../llm/README.md) 的降级链。

从根目录运行 `npm run build` 构建依赖，再运行 `npm run example -w toy-llm-openai-compatible` 或 `npm test -w toy-llm-openai-compatible`。[示例](./examples/basic.mjs) 使用注入的 HTTP 响应。
