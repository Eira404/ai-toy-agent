# toy-tools

挂载到 `ctx.tools` 的本地函数工具目录。注册时用 Ajv 编译参数 JSON Schema。调用模型前，`resolve({ scope, payload, providerCapabilities })` 固定本次请求可见的工具声明和对应的本地执行器。

`payload` 是当前 Turn 的业务数据，类型为只读的 `Record<string, unknown>`。工具通过 `isAvailable(scope, payload)` 读取并自行校验需要的字段，例如检查 `payload.allowMath === true`。调用方省略 `payload` 时，工具收到空对象。

把快照的 `schemas` 发给模型，再用同一个快照的 `execute(toolCall, { signal })` 处理模型返回的请求。注册和注销会影响之后创建的快照。执行时先解析参数，再跑 Schema 校验，通过后才调用 Handler。普通失败返回可交回模型的文本及错误阶段，取消会以 `signal.reason` 拒绝。Handler 通过上下文读取当前用户、设备、Session 和 Turn。

Handler 的返回值是「给模型的内容」；如需同时保存一些**不暴露给模型**的结构化数据（例如检索命中的记忆 id），在返回前调用 `context.record(data)`：

```ts
execute: async (_args, context) => {
  const memories = await retrieve(...)
  context.record({ retrievedIds: memories.map((m) => m.id) }) // 只持久化，不进模型
  return memories.map((m) => m.text).join("\n")                // 给模型
}
```

`record` 的数据会进 `ToolExecutionResult.data`，由 Agent Loop 写入 `tool_result` 事件的 `payload.data`；模型的工具结果消息只含 Handler 的返回值。

## 内置工具

`registerBuiltin` 注册**由模型供应商执行**的内置工具（没有本地 `execute`，例如 `web_search`）：

```ts
ctx.tools.registerBuiltin({
  name: "web_search",
  description: "获取实时网络信息",
  isAvailable: (_scope, payload) => payload.policy?.allowWeb === true, // 可选，省略默认注入
})
```

`resolve` 返回的 `schemas` 是 `function` + `builtin` 的联合；内置工具按两重条件过滤：
Provider 声明支持的 `providerCapabilities.builtinTools` 名单 + 业务 `isAvailable`。Provider 各自在其
adapter 里声明自己支持哪些内置工具名（如 `llm-openai-responses` 的 `builtinTools: ["web_search"]`）。

从根目录运行 `npm run build` 构建依赖，再运行 `npm run example -w toy-tools` 或 `npm test -w toy-tools`。[示例](./examples/basic.mjs) 展示注册和调用一个本地工具。
