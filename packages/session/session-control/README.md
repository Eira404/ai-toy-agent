# toy-session-control

关闭会话的本地工具插件，挂载到 `ctx.sessionControl`。它向 `ctx.tools` 注册一个 `close_session`
工具，模型在用户告别时调用它即可关闭当前会话。

```ts
await ctx.plugin(SessionControl)
// 可选配置
await ctx.plugin(SessionControl, { toolName: "end_conversation" })
```

- 工具执行时把关闭动作挂到当前 Turn 之后（fire-and-forget），当前 Turn 会正常跑完并输出道别语，
  随后 Session 进入 closing。
- 工具返回给模型的内容可通过 `farewellInstruction` 配置，默认是「会话已标记为关闭。请礼貌地向
  用户告别……」，模型据此生成道别语。

## 挂载顺序

```text
SessionData → ToySession → ToolRegistry →（LlmRuntime → AgentService → AgentLoop）→ SessionControl
```

[测试](./test/session-control.test.mjs) 覆盖「用户说再见 → LLM 调 close_session → 本轮道别 →
会话关闭」的完整链路。
