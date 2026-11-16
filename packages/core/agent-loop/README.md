# toy-agent-loop

实现 Agent 的默认执行循环：Turn 预处理、模型与工具闭环、阻塞后处理和非阻塞后处理。它只接受
`toy-session` 创建并交付的 Turn，通过 `appendEvents` 写入事件日志，不直接访问 Provider handle。

## 执行流程

```text
前台队列内（阻塞）:
  ① turn.preprocessing —— LifecycleGraph，阻塞，产出 {items, data}
  ② model + tool 循环 —— system prompt 组装 → tools.resolve → llm.stream → tool.execute → 循环(maxSteps)
  ③ blockingPost      —— LifecycleGraph，阻塞；答案已 append，但还没 return，队列仍被占用
  返回 AgentResult
───────────────────────────── 队列释放，下一个 turn 可以开始
  ④ nonBlockingPost   —— dispatch() 立即返回；setImmediate 后台执行，不占队列
```

## 四阶段语义

| 阶段 | 时机 | 能否写 Session 事件 | 结果可见性 |
| ---- | ---- | ------------------- | ---------- |
| `preprocessing` | 模型调用前，阻塞 | 否（只读） | `data` 喂 system prompt 与 `tools.resolve({ payload })`，不持久化 |
| 模型 + 工具 | ② | 是（`assistant_message` / `tool_call` / `tool_result`） | 下一轮 `history` 与 `getPreviousTurns` |
| `blockingPost` | 回答后、返回前，阻塞 | 是（`appendEvents`） | 下一轮立即可见；失败使本轮失败 |
| `nonBlockingPost` | 返回后，后台 | 否（写 memory 等外部服务） | 下一轮经 memory-read 可见 |

处理器上下文里的 `signal`、`upstream` 与共享 `state` 由 `toy-lifecycle` 执行器注入。执行顺序由
`dependsOn` 决定；`upstream` 只含直接依赖的返回结果，`state` 是同一份可变对象、可读写任意 key，
依赖链上已完成节点的写入（含传递依赖）对后续节点可见。`preprocessing` 和 `blockingPost` 失败会
阻止本轮成功，`nonBlockingPost` 失败只记录日志。

## 挂载和调用

```ts
import { Context } from "cordis"
import { SessionData } from "toy-session-data"
import { ToySession } from "toy-session"
import { AgentService } from "toy-agent"
import { AgentLoop, SystemPromptAssembler } from "toy-agent-loop"

const ctx = new Context()
await ctx.plugin(SessionData)
await ctx.plugin(ToySession)
await ctx.plugin(AgentService)
await ctx.plugin(AgentLoop, { provider: "openai", model: "gpt-4o-mini" })
await ctx.plugin(SystemPromptAssembler)

// 注册两个预处理节点，演示共享 state 的读与写。
const unregisterIntent = ctx.agentLoop.preprocessing.register({
  name: "intent",
  process: ({ message, state }) => {
    state.intent = message.includes("天气") ? "weather" : "chitchat"
    return { intent: state.intent }
  },
})
const unregisterEmotion = ctx.agentLoop.preprocessing.register({
  name: "emotion",
  dependsOn: ["intent"],
  process: ({ state }) => {
    // 依赖声明保证 intent 已完成，这里能读到它写进 state 的值。
    state.emotion = state.intent === "weather" ? "curious" : "neutral"
    return { emotion: state.emotion }
  },
})

// 消息组装插件注册有序片段，进入 system message。
const unregisterPersona = ctx.systemPrompt.registerSection({
  name: "persona",
  order: 100,
  render: () => "你是玩具设备中的中文助手。",
})

// 注册一个阻塞后处理节点（写入下一轮需要读到的 Session 事件）。
const unregisterBlocking = ctx.agentLoop.blockingPost.register({
  name: "commit-state",
  process: async ({ appendEvents }) => {
    await appendEvents([{ eventType: "turn_state", payload: { committed: true } }])
  },
})

const sessionId = await ctx.session.createSession({ userId: "u1", deviceId: "d1" })
const { result } = await ctx.session.runTurn(sessionId, { message: { text: "你好" } })

await ctx.session.requestClose(sessionId)
await ctx.session.waitForPostprocessing()
unregisterBlocking()
unregisterPersona()
unregisterEmotion()
unregisterIntent()
```

## 消息组装插件

System 与 User 两段文本由消息组装插件产出，Agent Loop 只负责拼成 `messages`。默认内置组装器
返回「基础指令 + 预处理 JSON + 工具说明」，加载 `SystemPromptAssembler` 后可替换它并通过
`registerSection` 注入有序片段。片段用 `target` 选择注入目标（默认 `"system"`），保留名
`"system"` / `"user"` 会覆盖对应的默认内容：

```ts
// 追加到 System 消息
ctx.systemPrompt.registerSection({ name: "persona", render: ({ session }) => `用户是 ${session.userId}` })

// 注入到 User 消息（在用户原文之后追加）
ctx.systemPrompt.registerSection({ name: "retrieval", target: "user", render: () => "相关记忆：…" })

// 用 name 覆盖默认：system 覆盖「基础指令 + 预处理 + 工具」，user 覆盖用户原文
ctx.systemPrompt.registerSection({ name: "system", render: () => "完全自定义的系统指令" })
ctx.systemPrompt.registerSection({ name: "user", target: "user", render: ({ message }) => `【问题】${message}` })

// 也可直接替换整个组装器
ctx.agentLoop.registerPromptAssembler({
  assembleSystemPrompt: ({ basePrompt }) => basePrompt,
  assembleUserMessage: ({ message }) => `问题：${message}`,
})
```

`assembleSystemPrompt` 每步都调用（工具每步重新解析），`assembleUserMessage` 每轮调用一次。

## 工具 meta

本地工具的 `execute(argumentsValue, context)` 会自动收到 `context` 中的 `userId`、`deviceId`、
`sessionId`、`turnId`、`toolCallId`（scope 信息由 Agent Loop 在 `tools.resolve` 时注入）。这些
只用于服务端内部，**不会进入模型的 `schemas` 或 System Message**——模型只看到工具的名称、描述和
参数 Schema。

## 错误处理

- 工具执行错误在 `toy-tools` 里被转成 `isError: true` 的工具结果交回模型，模型可据此自我纠正，
  不直接抛错（取消除外）。
- 模型错误 / 取消 → `AgentError`（`LLM_ERROR` / `ABORTED`），沿 `runTurn` 向上拒绝。
- `preprocessing` / `blockingPost` 节点失败 → `LifecycleProcessorError`，本轮失败并向上传播。
- `nonBlockingPost` 失败只记日志，不影响本轮结果。
- 最上层由调用 `runTurn` 的宿主决定重试、上报或忽略；Session 不吞错，已写入的事件保留。

## 单轮配置

`runTurn` 的 `config` 可覆盖 `provider`、`model`、`temperature`、`maxTokens`，缺省回退到
构造参数 `AgentLoopConfig`。`maxSteps` 与 `recentTurns` 只读，用于限制单轮模型步数与预处理
可见的最近完整 Turn 数。

## 示例和测试

```powershell
npm run example -w toy-agent-loop
npm test -w toy-agent-loop
```

[示例](./examples/basic.mjs) 用本地假模型展示一次完整 Turn 的预处理、回答与后处理事件流。
