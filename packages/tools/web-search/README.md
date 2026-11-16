# toy-web-search

`web_search` 内置工具插件，挂载到 `ctx.webSearch`。它向 `ctx.tools` 注册一个由模型供应商执行的
内置工具（没有本地 `execute`）。

```ts
await ctx.plugin(WebSearchTool)
// 可选配置
await ctx.plugin(WebSearchTool, { description: "搜索实时信息" })
```

- 是否真正发给模型由 Provider 声明的 `builtinTools` 能力决定（如 `llm-openai-responses` 配置
  `builtinTools: ["web_search"]`）。
- `isAvailable` 当前恒返回 `true`，后续按需改成按 `scope`/`payload` 判断。

## 挂载顺序

```text
ToolRegistry →（LlmRuntime → AgentLoop）→ WebSearchTool
```
