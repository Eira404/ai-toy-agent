# toy-mode-analysis

用 JEV 判断「默认 / 英语对练」模式的 turn 预处理插件。向 Agent Loop 注册两个节点：

- preprocessing `mode`：从 `previousTurns` 恢复上一轮模式 → JEV 判断四个软信号 → 代码状态机推出新模式；
- blockingPost `mode-commit`：把新模式写回 `mode_state` 事件，下一轮可见。

结果 `{ defaultMode, englishPractice }` 进入 `preprocessing.data.mode`，会随预处理 JSON 注入 system
prompt；加载 `SystemPromptAssembler` 时还会注入一个按模式作答的自然语言片段。

```ts
await ctx.plugin(ToyModeAnalysis, { provider: "typesafe" })
```

加载顺序：`toy-jev`（注册 Adapter）→ `toy-agent-loop` → `toy-mode-analysis`。

## 状态

| englishPractice | defaultMode | 含义 |
| --------------- | ----------- | ---- |
| `no`            | `yes`       | 默认模式 |
| `yes`           | `no`        | 英语对练中 |
| `pending-exit`  | `no`        | 英语对练·待退出 |

`defaultMode` 由代码推导（退出英语对练即回到默认）。JEV 不做状态机，只回答四个独立的软信号
（`english` / `startContinue` / `stop` / `relevantChinese`，各为 0~1），状态机 `nextEnglishPracticeMode`
在代码里据信号和上一状态推出 `yes / pending-exit / no`。目录与输入/输出 Schema 从本包导出，新增模式
只维护 `mode-catalog.ts`。

## 跨轮持久化

模式是有状态判断，上一轮结果决定本轮如何转移。本包通过 `mode_state` 会话事件保存：preprocessing 从
`previousTurns` 读回最近一条 `mode_state`，blockingPost 把本轮结果写回。该事件类型不在文本历史投影
范围内，不会污染主模型的 `history`。

## 示例和测试

```powershell
npm run build -w toy-mode-analysis
npm test -w toy-mode-analysis
```
