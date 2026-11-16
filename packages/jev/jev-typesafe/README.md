# toy-jev-typesafe

为 `toy-jev` 注册一个 TypeSafe HTTP 路由。适配器把模型名、文本和问题写入 JSON 请求，并把认证、超时、取消和响应格式处理在 HTTP 边界。

先挂载 `JevRuntime`，再挂载本包的 `JevTypesafePlugin`：

```js
import { JevRuntime } from "toy-jev"
import { JevTypesafePlugin } from "toy-jev-typesafe"

await ctx.plugin(JevRuntime)
await ctx.plugin(JevTypesafePlugin, {
  provider: "typesafe",
  baseURL: "https://api.example.com",
  apiKey,
})

// 模型在调用时指定（adapter 不持有模型）；降级链里则由链条目给 model
await ctx.jev.invoke(state, questions, { provider: "typesafe", model: "jev-1.14.0" })
```

随后通过 `ctx.jev.invoke` 调用。HTTP 失败会携带状态、请求 ID 和可用的重试提示（`retryable`），调用方决定是否重试。

同一插件类可通过不同的 `provider` 加载多次，注册多条路由。路由级失败降级见 [`toy-jev`](../jev/README.md) 的降级链。

从根目录运行 `npm run build` 构建依赖，再运行 `npm run example -w toy-jev-typesafe` 或 `npm test -w toy-jev-typesafe`。[示例](./examples/basic.mjs) 通过注入的 HTTP 响应运行。
