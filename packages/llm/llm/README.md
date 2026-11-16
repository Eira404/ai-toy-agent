# toy-llm

挂载到 `ctx.llm` 的通用模型服务。模型调用以供应商无关的消息、内容块和流事件表示。消息可以包含文本、推理和工具调用。工具结果通过 `toolCallId` 对应本轮的模型请求。

- `registerAdapter(provider, adapter)` 注册命名路由并返回注销函数。适配器插件可以用 `ctx.effect` 管理注销。
- `providerInfo(provider)` 返回能力快照，可用来筛选工具。
- `stream({ provider, model, messages, tools, signal })` 返回异步流，完整消费时以一次 `finish` 结束。调用失败和取消分别是 `error` 和 `aborted`。提前停止迭代会清理底层流。
- `generate(options)` 消费同一套流并组装为内容块、用量和结束原因。拿到 `tool-calls` 后，由调用方执行工具和组织下一次模型请求。
- 支持续调的路由会在工具调用时提供 `continuation` 事件或结果字段。调用方在同一轮的后续请求传回句柄及工具结果。

## 降级链（fallback）

`registerChain(name, entries, options?)` 注册一个逻辑路由：按 `entries` 顺序尝试，前一个「可降级失败」则自动尝试下一个，全部失败才报错。

```js
ctx.llm.registerAdapter("dashscope", dashscopeAdapter)
ctx.llm.registerAdapter("deepseek", deepseekAdapter)

ctx.llm.registerChain("main", [
  { provider: "dashscope", model: "qwen3.7-max" },   // 默认
  { provider: "dashscope", model: "qwen3.5-flash" }, // 备 1
  { provider: "deepseek", model: "deepseekv4-pro" }, // 备 2
])

await ctx.llm.generate({ provider: "main", messages }) // model 由链决定
```

要点：

- 用链名调用时，`options.model` 被链覆盖；每个候选的 `provider` 必须是已注册的 adapter 名。
- 默认对 `TRANSPORT` / `TIMEOUT` / `EMPTY_RESPONSE` / `STREAM_CLOSED` / `MALFORMED_STREAM` 以及 HTTP `408`、`429`、`5xx` 降级；`ABORTED`、参数/鉴权错误等不降级。可用 `options.retryable` 覆盖判定。
- `stream()` 只在首个内容 chunk 之前失败才切换；已向调用方吐出内容后失败会直接上报，避免拼接两段输出。`generate()` 非流式则整体重试。
- 切换候选时，若 `continuation` 指向其它 provider/model，会被丢弃（退回消息重放）。
- 全部失败返回 `FALLBACK_EXHAUSTED`，并在 `failure.attempts` 中携带各候选的失败信息；`options.onFallback` 可在每次切换时回调。

[示例](./examples/basic.mjs) 使用本地适配器。可从仓库根目录运行 `npm run example -w toy-llm` 或 `npm test -w toy-llm`。
