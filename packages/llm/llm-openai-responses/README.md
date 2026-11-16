# toy-llm-openai-responses

挂载到 `toy-llm` 的 Responses 路由。支持文本和推理摘要流、本地函数工具、配置允许的服务端内置工具、结构化输出、用量、超时和取消。

```ts
import { LlmRuntime } from "toy-llm"
import { OpenAIResponsesPlugin } from "toy-llm-openai-responses"

await ctx.plugin(LlmRuntime)
await ctx.plugin(OpenAIResponsesPlugin, {
  provider: "responses",
  baseURL: "https://api.openai.com/v1",
  apiKey,
  builtinTools: ["web_search"],
})
```

调用 `ctx.llm.generate` 或 `ctx.llm.stream` 时指定 provider、model 和通用消息。思考强度通过 `reasoning.effort` 指定，显式关闭映射为 `effort: "none"`。具体可用等级取决于模型。Responses 使用等级控制，开启思考时传入 `budgetTokens` 会返回 `UNSUPPORTED_OPTION`。

本地函数调用成功完成后，`generate` 返回 `continuation`，流式调用则会在 `finish` 前发出对应事件。执行工具后，把全部工具结果作为消息尾部传回，并将这个句柄交给下一次调用。每次请求都可以重新传入系统消息作为 instructions。

- 默认 `store: false`。适配器请求加密推理 Item，并在下一次调用重放本轮的原始 Item。
- 显式设置 `store: true` 后，通过 `previous_response_id` 回传当前工具结果。
- 续调句柄只用于当前模型循环。无状态句柄可能包含对话数据，调用方应随 Turn 结束释放。

同一插件类可通过不同的 `provider` 加载多次，注册多条路由。路由级失败降级见 [`toy-llm`](../llm/README.md) 的降级链。

从根目录构建依赖后，运行 `npm run example -w toy-llm-openai-responses` 或 `npm test -w toy-llm-openai-responses`。[示例](./examples/basic.mjs) 使用注入的 HTTP 响应。

[OpenAI Responses 迁移指南](https://developers.openai.com/api/docs/guides/migrate-to-responses?api-mode=responses) · [Responses 流事件](https://developers.openai.com/api/reference/resources/responses/streaming-events)
