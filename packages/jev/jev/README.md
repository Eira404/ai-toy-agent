# toy-jev

挂载到 `ctx.jev` 的结构化评估服务，支持 `choice`、`score` 和 `noul`。业务插件定义问题和候选项，适配器执行实际请求。

- `registerAdapter(provider, adapter)` 注册路由并返回注销函数。
- `invoke(state, questions, { provider, model, signal })` 接收非空文本和按名称索引的问题。只有一个已注册路由时可以省略 `provider`；`provider` 是单 adapter 时必须给 `model`（adapter 不持有模型），是降级链时 `model` 由链条目决定。
- 服务校验响应结构、问题名、答案类型和 choice 候选项。失败通过 `JevError.code` 区分，取消使用 `ABORTED`。

## 降级链（fallback）

`registerChain(name, entries, options?)` 注册一个逻辑路由：按 `entries` 顺序尝试，前一个「可降级失败」则自动尝试下一个，全部失败才报错。每个候选是 `{ provider, model }`——与 LLM 一致，model 在调用时（链条目）确定，不在 adapter 注册时确定。

```js
ctx.jev.registerAdapter("typesafe", typesafeAdapter)
ctx.jev.registerAdapter("backup", backupAdapter)

ctx.jev.registerChain("main", [
  { provider: "typesafe", model: "jev-1.14.0" },   // 默认
  { provider: "typesafe", model: "jev-1.13.0" },   // 同一 adapter 换模型降级
  { provider: "backup", model: "backup-1" },       // 换 adapter 兜底
])

await ctx.jev.invoke(state, questions, { provider: "main" }) // model 由链决定
```

要点：

- 每个候选的 `provider` 必须是已注册的 adapter 名，`model` 必填。
- 默认对标记为 `retryable` 的失败（超时、传输错误、`429`/`5xx` 等）降级；`ABORTED`、参数/鉴权错误等不降级。可用 `options.retryable` 覆盖。
- 全部失败抛出 `JevError`，`code` 为 `FALLBACK_EXHAUSTED`，并在 `attempts` 中携带各候选的失败摘要；`options.onFallback` 在每次切换时回调。

[示例](./examples/basic.mjs) 使用本地评估器。可从仓库根目录运行 `npm run example -w toy-jev` 或 `npm test -w toy-jev`。
