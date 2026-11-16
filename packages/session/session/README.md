# toy-session

挂载到 `ctx.session` 的 Cordis 服务。创建调用完成预处理后返回 Session ID，随后可以反复调用 Turn。申请关闭会等当前 Turn 结束并释放用户玩偶占用，旧 Session 的后处理在后台继续。

## 挂载和调用

先挂载 `toy-session-data` 和 `toy-session`，再由 Agent 插件调用 `registerTurnExecutor`。Agent 可以用 `ctx.effect` 把注销函数绑定到自己的卸载周期。使用数据库时，由宿主按 [toy-session-data 的挂载顺序](../session-data/README.md#挂载示例) 启动存储服务。

```ts
await ctx.plugin(SessionData)
await ctx.plugin(ToySession)
await ctx.plugin({
  name: "agent",
  inject: ["session"],
  apply(agentCtx: Context) {
    agentCtx.effect(() =>
      agentCtx.session.registerTurnExecutor((input) => agent.executeTurn(input)),
    )
  },
})

const unregister = ctx.session.preprocessing.register({
  name: "profile",
  process: ({ userId }) => ({ owner: userId }),
})

const sessionId = await ctx.session.createSession({ userId: "u1", deviceId: "d1" })
const { turnId, result } = await ctx.session.runTurn(sessionId, {
  message: { text: "你好" },
  config: { thinking: false },
})
await ctx.session.requestClose(sessionId)

// 宿主停机或测试结束时等待后台任务完成。
await ctx.session.waitForPostprocessing()
unregister()
```

每个 Session 服务同时接受一个执行器。未注册执行器时可以创建和关闭 Session，Turn 会在写入前以 `invalid-state` 失败。注销后，已开始的 Turn 继续用原执行器，排队的 Turn 在开始时读取当前注册。

## Agent 执行上下文

| 字段                      | 用法                                                                                                          |
| ------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `session`、`turn`         | 已创建的记录快照。前处理结果在 `session.payload.preprocessing`。                                              |
| `message`                 | 当前用户消息，已由 Session 写成当前 Turn 的第一条 `user_message`。                                            |
| `config`                  | 可选的单轮执行配置，例如 `{ thinking: false }`。Session 在入队时取快照，字段由 Agent 解释。                   |
| `signal`                  | 调用方传给本轮的取消信号。Agent 可将同一个信号传给模型流、工具和子工作流。                                    |
| `turnCount`               | 此 Session 已创建的 Turn 总数，包含当前轮。                                                                   |
| `history`                 | 当前轮之前的文本对话，按轮次和轮内顺序排列，可直接组成 Chat 模型的 `messages`。                               |
| `getPreviousTurns(count)` | 读取前几轮的原始 Event，用于需要工具事件等完整数据的执行器。                                                  |
| `appendEvents(events)`    | 向当前 Turn 写入事件。助手文本使用 `assistant_message` 和 `payload: { text }`。执行器应在返回前等待写入完成。 |

典型的模型输入是 `[...history, { role: "user", content: message.text }]`。`history` 由带文本的 `user_message`、`assistant_message` 组成。执行器的返回值通过 `runTurn` 的 `result` 交给调用方。

## 中断 Turn

调用方可以为每次 `runTurn` 创建一个 `AbortController`，并在需要停止时调用 `abort()`。

```ts
const controller = new AbortController()
const turn = ctx.session.runTurn(sessionId, {
  message: { text: "你好" },
  signal: controller.signal,
})

// 用户点击停止时调用 controller.abort()
await turn
```

- 开始前取消时，调用立即以 `signal.reason` 拒绝，该请求轮到执行时跳过。
- 创建 Turn 已经开始时，Session 先写完用户消息。此时收到取消会跳过 Agent，已接收的用户消息保留。
- Agent 执行中收到取消时，应停止下游工作并等待收尾。Session 等执行器真正退出后以 `signal.reason` 拒绝调用，再放行下一轮。此前写入的 Event 保留。
- `requestClose` 会等待已开始的 Turn 退出。要中断当前轮再关闭时，先取消当前轮的信号，再申请关闭。

## 预处理和后处理

- 通过 `preprocessing.register` 和 `postprocessing.register` 注册处理器。各阶段分别解析 `dependsOn`，返回的注销函数可绑定到业务插件的卸载回调。
- 创建时先执行前处理，成功后保存 `payload.initial` 和 `payload.preprocessing`。处理器可以返回 JSON，省略返回值会保存为 `null`。
- `requestClose` 会拒绝尚未开始的 Turn，等待当前轮完成后返回 `closing` 记录。此时同一用户的同一玩偶可以创建并运行下一次 Session。
- 旧 Session 的后台任务先等待它的 Event 落库，再把完整历史快照交给后处理器。成功时保存 `payload.postprocessing` 并写入 `closed`。失败时记录日志并保留 `closing`，再次调用 `requestClose(sessionId)` 可以重试。会写外部资源的处理器应按 `sessionId` 幂等执行。
- 后台任务和待写 Event 队列在当前进程内。数据库模式下，可通过 `ctx.sessionData.agent.restoreSession(sessionId)` 恢复已落库的历史，再继续 active Session 或重新申请关闭。

## 示例和测试

```powershell
npm run example -w toy-session
npm test -w toy-session
```

[示例](./examples/basic.mjs) 使用内存模式和一个假的执行器，展示第二轮的模型输入，以及旧 Session 后处理期间创建新 Session。
