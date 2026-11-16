# toy-lifecycle

预处理和后处理共用的 TypeScript 工作流执行器。每个阶段可以创建自己的 `LifecycleGraph` 实例，由调用方决定运行时机、输入和结果用途。

```ts
import { LifecycleGraph } from "toy-lifecycle"

const graph = new LifecycleGraph<{ readonly userId: string }>()

const unregisterProfile = graph.register({
  name: "profile",
  process: ({ userId }) => ({ userId, language: "zh" }),
})

const unregisterContext = graph.register({
  name: "context",
  dependsOn: ["profile"],
  process: ({ upstream }) => ({ profile: upstream.profile }),
})

const result = await graph.run({ userId: "u1" })
console.log(result.data.context)
unregisterContext()
unregisterProfile()
```

- `register` 返回注销函数。注册和注销只影响后续运行。处理器可以按任意顺序注册，运行前会检查缺失依赖和环。
- 无依赖的节点可以并行运行。节点的直接依赖全部成功后即可执行，`upstream` 只包含这些依赖的结果。
- 每次运行还有一份共享的可变 `state`：所有处理器拿到同一个对象，可读写任意 key；依赖链上已完成节点的写入对后续节点可见（含传递依赖），独立并行分支写同一 key 会有竞态，用 `dependsOn` 声明顺序。结束时 `result.state` 返回同一份对象。
- `result.data` 按节点名索引结果，`result.items` 包含每个节点的结果和耗时。较小的 `order` 排在前面，默认值是 `0`，同值按注册顺序排列。执行顺序由依赖关系决定。
- 节点失败时，其下游跳过，独立分支继续执行。整张图收尾后，`run` 抛出带有 `processorName` 和 `cause` 的 `LifecycleProcessorError`。
- `run(context, { signal })` 在取消后跳过尚未开始的节点，并等待正在运行的节点退出。节点收到同一个 `signal`，可以据此取消自己的异步操作。

节点之间也可以用共享 `state` 传中间数据。注意 `state` 不提供执行顺序——谁先谁后仍由 `dependsOn`
决定；它省去的是「把传递依赖也声明成直接依赖，或让中间节点 return 中转」：

```ts
const graph = new LifecycleGraph<{ readonly message: string }>()

const unregisterIntent = graph.register({
  name: "intent",
  process: ({ message, state }) => {
    state.intent = message.includes("天气") ? "weather" : "chitchat"
    return { intent: state.intent }
  },
})

const unregisterEmotion = graph.register({
  name: "emotion",
  dependsOn: ["intent"],
  process: ({ state }) => {
    // 依赖声明保证 intent 已完成，这里能读到它写进 state 的值。
    state.emotion = state.intent === "weather" ? "curious" : "neutral"
    return { emotion: state.emotion }
  },
})

const result = await graph.run({ message: "天气怎么样" })
console.log(result.state.intent) // "weather"
console.log(result.state.emotion) // "curious"
unregisterEmotion()
unregisterIntent()
```

在项目根目录运行 `npm test -w toy-lifecycle`。
