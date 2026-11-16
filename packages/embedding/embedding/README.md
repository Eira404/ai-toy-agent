# toy-embedding

挂载到 `ctx.embedding` 的通用批量嵌入服务。一次调用输入多条文本，返回与文本顺序一致的向量、模型名和维度。业务插件按名称注册适配器，具体协议由适配器包实现。

- `registerAdapter(provider, adapter)` 注册命名路由并返回注销函数。适配器插件可以用 `ctx.effect` 管理注销。
- `providerInfo(provider)` 返回路由信息快照。
- `embed({ provider, model, texts, operation, signal })` 校验输入、解析路由并返回结果。取消使用 `ABORTED`，失败通过 `EmbeddingError.code` 区分。
- 成功返回的 `dimensions` 始终是正整数，向量数量与文本数量一致，调用方可据此校验与向量存储 Schema 的一致性。

## 降级链（fallback）

`registerChain(name, entries, options?)` 注册一个逻辑路由：按 `entries` 顺序尝试，前一个「可降级失败」则自动尝试下一个，全部失败才报错。

```js
ctx.embedding.registerAdapter("dashscope", dashscopeAdapter)
ctx.embedding.registerAdapter("deepseek", deepseekAdapter)

ctx.embedding.registerChain("main", [
  { provider: "dashscope", model: "text-embedding-v3" },
  { provider: "deepseek", model: "deepseek-embed" },
])

await ctx.embedding.embed({ provider: "main", texts })
```

要点：

- 用链名调用时，`request.model` 被链覆盖；每个候选的 `provider` 必须是已注册的 adapter 名。
- 默认对标记为 `retryable` 的失败（超时、传输错误、`429`/`5xx` 等）降级；`ABORTED`、参数/鉴权错误等不降级。可用 `options.retryable` 覆盖。
- 全部失败抛出 `EmbeddingError`，`code` 为 `FALLBACK_EXHAUSTED`，并在 `attempts` 中携带各候选的失败摘要；`options.onFallback` 在每次切换时回调。

[示例](./examples/basic.mjs) 使用本地适配器。可从仓库根目录运行 `npm run example -w toy-embedding` 或 `npm test -w toy-embedding`。
