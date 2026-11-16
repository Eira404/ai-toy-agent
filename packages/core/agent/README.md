# toy-agent

挂载到 `ctx.agent` 的 Cordis 服务，是 Agent 的公共契约与 Session 适配入口。它持有
`AgentTurnInput`、`AgentResult`、`AgentEvent`、`AgentStep`、`AgentError`、`AgentRunner` 等契约，
把 `toy-session` 的 Turn 执行器转发给唯一注册的 Agent Loop。具体模型与工具循环由
`toy-agent-loop` 提供，并通过 `registerRunner()` 注册。

## 挂载和调用

先挂载 `toy-session-data`、`toy-session`、`toy-agent`，再挂载 `toy-agent-loop`（它会注入
`agent`、`llm`、`tools` 等依赖）。Agent 在挂载时就接好 `ctx.session.registerTurnExecutor`，
运行期再从 runner 拉取事件流。

```ts
import { Context } from "cordis"
import { SessionData } from "toy-session-data"
import { ToySession } from "toy-session"
import { AgentService } from "toy-agent"
import { AgentLoop } from "toy-agent-loop"

const ctx = new Context()
await ctx.plugin(SessionData)
await ctx.plugin(ToySession)
await ctx.plugin(AgentService)
await ctx.plugin(AgentLoop, {
  provider: "openai",
  model: "gpt-4o-mini",
  systemPrompt: "你是玩具设备中的中文助手。",
})
```

`runTurn` 返回 `{ turnId, result }`，其中 `result` 是执行器的返回值，即 `AgentResult`：

```ts
const sessionId = await ctx.session.createSession({ userId: "u1", deviceId: "d1" })
const { turnId, result } = await ctx.session.runTurn(sessionId, {
  message: { text: "你好" },
  config: { temperature: 0.7 },
})

console.log(result.text) // "你好，有什么可以帮你？"
```

## 事件流

核心输出是 `AsyncIterable<AgentEvent>`，由 `ctx.agent.stream(input)` 或 `ctx.agent.run(input)`
消费。当前默认事件接收器是内存收集器（`run()` 把流收成 `AgentResult`）；未来 gRPC server-stream
只需实现同一份事件的传输：gRPC 处理函数作为 Turn 执行器，边 drain `stream()` 边写，drain 完再
return，即可复用 Session 队列的串行语义。

事件包含 `run-start`、`preprocessing-complete`、`model-request`、`model-ttft`、`agent-ttft`、
`assistant-delta`、`assistant-complete`、`tool-start`、`tool-complete`、`blocking-post-complete`、
`nonblocking-post-dispatched`、`complete`。

## 取消与错误

- `runTurn` 的 `signal` 会传给预处理、模型流、工具和后处理；取消后循环抛出
  `AgentError`，错误码为 `ABORTED`。
- 稳定错误码：`NO_RUNNER`、`INVALID_REQUEST`、`LLM_ERROR`、`ABORTED`、`MAX_STEPS`。
- 阻塞后处理失败会向上传播，使本轮 `runTurn` 拒绝；非阻塞后处理失败只记录日志。
