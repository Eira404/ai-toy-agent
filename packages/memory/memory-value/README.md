# toy-memory-value

记忆价值引擎。实现 `toy-memory-feedback` 的 `FeedbackValueEngine` 与
`toy-memory-daily` 的 `MemoryValueEngine`，通过同一个 `ValueEngine` 实例提供两侧能力。

数值核心沿用 `ai-toy-agent-mem-v0` 的重要性、巩固、峰值恢复与幂律遗忘算法；
语义部分使用 `toy-model-support` 的 `LlmSupportModel` 完成结构化 LLM 判断。
本包处理单元价值计算，不操作记忆正文或数据表。

## 挂载

宿主先加载 LLM runtime/adapter、MemoryFeedback 与 MemoryDaily，然后挂载本插件：

```ts
import { MemoryValue } from "toy-memory-value"

await ctx.plugin(MemoryValue, {
  llmProvider: "your-provider",
  llmModel: "your-model",
})
```

`MemoryValue` 自动把同一个底层引擎注册到 feedback 和 daily。注册失败时回滚，卸载时
注销两侧注册。宿主也可以自行创建 `new ValueEngine(ctx.llm, config)` 并管理注册。

服务入口是 `ctx.memoryValue`，提供下面七个方法：

| 方法                                                  | 行为                                                     | 模型                              |
| ----------------------------------------------------- | -------------------------------------------------------- | --------------------------------- |
| `judgeSession(input)`                                 | 根据召回正文、助手语境和后续用户原文判断态度及证据       | LLM；没有后续用户表达时直接无信号 |
| `initialize(inputs)`                                  | 按输入顺序逐个判断重要性并初始化，返回一一对应的状态数组 | LLM                               |
| `settle({ state, judgements })`                       | 按输入顺序应用反馈强化，**不衰减**                       | 无                                |
| `reinforceUpdated({ state, oldContent, newContent })` | 异步判断正文变化并强化，**不衰减**                       | 正文有差异时 LLM                  |
| `decay(state)`                                        | 推进一个有效衰减周期                                     | 无                                |
| `max(a, b)`                                           | 返回价值较大的完整状态                                   | 无                                |
| `lifecycle(state)`                                    | 返回 `active` / `observing` / `archived`                 | 无                                |

`reinforceUpdated` 的返回值是 `Promise<ValueState>`，Daily 的概述与 detail 调用均已
改为等待其完成。引擎只推进一次传入的周期，不决定何时调用 `decay`。

## 按方法使用

常规调用通过 `ctx.memoryValue`；feedback/daily 已注册时也会调用同一个底层引擎。
下面的片段按顺序共享变量，展示单个 overview 的完整价值计算。完整可运行版本见
[examples/basic.mjs](examples/basic.mjs)。

### 1. initialize：新单元建立初始价值

传入内容，不需要提前判断重要性或拼写数值状态。返回状态数组与输入顺序一致；
detail 的 title 填父块标题，body 填该条细节正文。空数组不调用模型，批次任一项失败则抛错。

```ts
const engine = ctx.memoryValue
const initialized = await engine.initialize([
  {
    unitType: "overview",
    domain: "self",
    title: "咖啡偏好",
    body: "用户喜欢冰美式。",
  },
])
const original = initialized[0]! // 本例传入一项，成功时必定返回一项。
```

initialize 不推进周期；此时状态仍处于初始化峰值。

### 2. judgeSession：从实际召回与用户表达生成反馈

输入复用 `toy-memory-feedback` 的类型。`recalledContent` 是首次召回正文，
`recallSnapshots` 覆盖各召回轮；用户证据必须严格晚于首次召回轮次。

```ts
import type { RecallUnit } from "toy-memory-feedback"

const unit: RecallUnit = {
  unitType: "overview",
  unitId: "coffee",
  blockId: "coffee",
  recalledContent: {
    title: "咖啡偏好",
    summary: "喜欢冰美式",
    overviewBody: "用户喜欢冰美式。",
  },
}
const judgement = await engine.judgeSession({
  ...unit,
  recallTurnNos: [1],
  recallSnapshots: [{ ...unit, turnNo: 1, turnId: "turn-1" }],
  recallAssistantTurns: [{ turnNo: 1, assistantText: "你喜欢冰美式。" }],
  relevantTurns: [{ turnNo: 2, userText: "对，我就是喜欢冰美式。", assistantText: "好的。" }],
  // signal: controller.signal, // 如需取消可透传 AbortSignal。
})
```

返回值是 `FeedbackJudgement`，包含态度、证据轮次、judgementData 和 judgementVersion，
尚未修改 original。应保留完整返回值供后续 settle 使用；不要用空的私有数据代替。

### 3. settle：应用反馈，得到 R0

`state` 是单元原状态；`judgements` 可以包含跨 Session 的多条判断，按调用方给定顺序应用。
此方法同步、不调用模型、不衰减；空反馈保留原数值。它不会标记反馈已消费。

```ts
const r0 = engine.settle({ state: original, judgements: [judgement] })
```

### 4. reinforceUpdated：根据正文变化得到 R7

必须 await；旧新内容必须属于相同 unitType。这里 overview/detail 的正文统一叫
`body`，所以 overview 需把召回或存储的 `overviewBody` 映射到 `body`。
本例的新正文代表调用方已经确定的内容；该方法只计算变化对应的价值，不保存新正文。

```ts
const r7 = await engine.reinforceUpdated({
  state: original, // 与 R0 从同一个原状态出发，不能在 R0 上再次叠加强化。
  oldContent: {
    unitType: "overview",
    title: "咖啡偏好",
    summary: "喜欢冰美式",
    body: "用户喜欢冰美式。",
  },
  newContent: {
    unitType: "overview",
    title: "咖啡偏好",
    summary: "喜欢冰美式和浅烘豆",
    body: "用户喜欢冰美式，偏好浅烘豆。",
  },
})
```

正文不变、纯润色或纠错不会强化旧状态；补充及有效状态变化使用 supplemented 增益。
所有分支都保持 I 不变且不衰减。未强化时可能返回原对象，请勿修改它的 valueData。

### 5. max：从同一单元的分支中选完整状态

只比较同一单元的原值、R0、R7，不用于比较不同记忆之间的检索顺序。
返回 a 或 b 的原对象，不累加增益，不合并字段。

```ts
const chosen = engine.max(engine.max(original, r0), r7)
```

### 6. decay：推进一次有效周期

在调用方确定本次需要推进周期时，传入选定的状态。R0/R7 内部没有衰减，
这里统一调用一次即可。把输出再次传入 decay 会多推进一个周期。

```ts
const final = engine.decay(chosen)
```

### 7. lifecycle：查询最终生命周期

只读查询，不会推进周期。返回值可与最终 ValueState 一起交回调用方保存。
原始数值仅在调试或引擎内部需要时解码，业务使用生命周期即可。

```ts
import { decodeValueState } from "toy-memory-value"

const lifecycleStatus = engine.lifecycle(final) // active / observing / archived
const debugData = decodeValueState(final) // 调试：I/S/P/A/V 与连续低值计数的副本。
```

## 入口与类型怎么选择

| 入口或类型                                                 | 使用场景                                                                 |
| ---------------------------------------------------------- | ------------------------------------------------------------------------ |
| `MemoryValue` / `ctx.memoryValue`                          | Cordis 宿主的默认入口，自动注册和注销两侧接口                            |
| `new ValueEngine(llm, config)`                             | 已有模型服务、需要自行组合和管理注册时使用                               |
| `ForgettingEngine`                                         | 已有重要性/反馈标签，只验证内部数值算法；不自动调用模型或封装 ValueState |
| `ValueState`（Long 导出）                                  | 包间传递的 `valueVersion + valueData` 外壳                               |
| `ValueData`                                                | 引擎内部六个数值字段；Schema 字段注释解释 I/S/P/A/V 的含义               |
| `JudgeSessionInput` / `FeedbackJudgement`（feedback 导出） | 态度判断的输入及完整输出，直接复用拥有方类型                             |
| `NewUnitInput` / `UnitContent`（daily 导出）               | 初始化及旧新正文输入；正文使用 body                                      |
| `MemoryValueConfig` / `ForgettingConfig`                   | 插件配置及完整数值配置；Schema 字段注释含默认值和范围                    |
| `decodeValueState` / `encodeValueState`                    | 调试解码、数值结果封装；不包含状态迁移或价值计算                         |

`settle`、`reinforceUpdated`、`decay` 都不会修改传入的状态，但返回的 JSON 不是冻结对象；
应将各个原值/分支视为只读。编码和解码会校验并复制内部数值对象，不会自动识别其他版本。

## 用户态度

输入直接复用 feedback 的 `JudgeSessionInput`：overview 正文保持
`{ title, summary, overviewBody }`，detail 保持 `{ summary, body }`。
`recallSnapshots` 保留各次实际召回版本，助手回答仅作语境，态度证据只能引用
首次召回之后、具有用户原文的 `relevantTurns`。

模型输出各项 `signals` 和主要态度。程序检查证据归属，并确保任何明确 `corrected`
信号都优先于正向主要态度。没有纠错时采用模型基于证据选择的主要态度。
沉默、没有反驳和普通的「谢谢」不构成确认。

返回的 `judgementVersion` 为 `1`，`judgementData` 是：

```ts
{
  reason: "简短的证据依据",
  signals: [{
    feedbackType: "confirmed",
    evidenceTurnNos: [2],
    reason: "第 2 轮明确确认",
  }],
}
```

`evidenceTurnNos` 是最终态度的证据并集，升序去重。`no_user_signal` 的证据和
signals 为空。`settle` 校验版本与该结构的一致性，不接受其他引擎的私有判断数据。
模型失败、非法输出和无效证据会明确报错，不会伪装成无信号；`judgeSession` 透传
AbortSignal，已取消调用不会生成反馈。

## 重要性与正文变化

| 重要性 | 判据                                             |    I |
| ------ | ------------------------------------------------ | ---: |
| low    | 临时、偶发、后续复用有限                         | 0.20 |
| normal | 普通偏好、习惯、关系或项目背景                   | 0.45 |
| high   | 对持续决策或交互影响明显的重要事实、目标、约束   | 0.70 |
| core   | 有明确内容依据的长期关键身份、核心约束或持续目标 | 1.00 |

Domain 仅作语境，正文长度不代表重要程度；core 也会自然衰减。

正文变化采用以下策略，重要性 I 始终不变：

| 变化          | 处理                     |
| ------------- | ------------------------ |
| unchanged     | 不强化                   |
| rephrased     | 不强化                   |
| supplemented  | 使用旧 supplemented 增益 |
| state_updated | 使用旧 supplemented 增益 |
| corrected     | 不强化旧状态             |

只改 title/summary、正文相同或仅正文边界空白变化时，直接返回原值，不调用模型。
不折叠 Markdown 内部空白。明确纠错不自动重置重要性，也不修改或替换正文。

## 数值算法

引擎私有状态包含 I（intrinsicImportance）、S（consolidationStrength）、
P（peakValue）、A（activityCycles）、V（currentValue）和 belowThresholdCycles。
A 是初始化或最近一次有效强化以来的周期数。

默认初始化：

```text
S = 0.1 × I
P = 0.45 + 0.4 × I
A = 0, V = P, belowThresholdCycles = 0
```

默认衰减：

```text
d = 0.05 + 0.73 / (1 + 0.85 × I) × (1 - S)
A = A + 1
V = P × (1 + A)^(-d)
```

| 反馈                                                | 巩固增益 | 恢复增益 |
| --------------------------------------------------- | -------: | -------: |
| confirmed                                           |     0.30 |     0.55 |
| supplemented                                        |     0.25 |     0.50 |
| follow_up                                           |     0.15 |     0.35 |
| no_user_signal / corrected / irrelevant / uncertain |        0 |        0 |

```text
g = spacingFloor + (1 - spacingFloor) × (1 - V)
S_new = S + 巩固增益 × g × (1 - S)
P_new = P + 恢复增益 × g × (1 - P)
```

有效强化后 `A=0`、`V=P_new`、低值计数归零。g 是根据当前 V 的间隔效果估计，
不直接测量实际时间。默认 V 低于 0.18 后进入观察，连续 7 个低值周期归档；
观察期可以强化恢复，已归档单元不再强化或衰减。初始单元在第一次衰减前保持 active，
与旧算法一致。

`max` 依次比较 V 更高、S 更高、P 更高、A 更小、低值计数更小，全部相同则保留 a；
返回被选中的完整输入状态，不混合两个分支字段。

## 状态版本与配置

数值使用 `valueVersion: "forgetting-v1"`，`valueData` 保存上述六个字段，
生命周期根据低值计数推导。状态解析检查数值范围、V 不超过 P、低值周期不超过 A。
`"none"` 和未知版本明确报错，需由调用方先初始化或迁移，不按零价值处理。

| 配置                       | 默认                     |
| -------------------------- | ------------------------ |
| `llmProvider` / `llmModel` | 必填                     |
| `temperature`              | 0                        |
| `maxTokens`                | 2048                     |
| `forgetting`               | 可选，部分覆盖旧算法参数 |

`DEFAULT_FORGETTING_CONFIG` 与 `ForgettingConfigSchema` 导出完整算法参数。
配置经校验并冻结，已有状态应使用一致的算法参数解释；更换策略前需评估或迁移状态。
错误通过 `ValueEngineError.code` 区分输入、状态、反馈版本和模型失败。

| code                            | 含义与处理方向                                               |
| ------------------------------- | ------------------------------------------------------------ |
| `invalid-input`                 | 检查单元类型、必需内容、召回快照和轮次归属                   |
| `invalid-state`                 | 检查数值 JSON 是否损坏、越界或计数不一致                     |
| `invalid-judgement`             | 检查模型证据或已保存反馈的态度/证据与私有数据是否一致        |
| `unsupported-value-version`     | 包括 none，先走显式初始化或迁移，不能当作零价值              |
| `unsupported-judgement-version` | 使用能理解该反馈格式的引擎或先迁移反馈                       |
| `model-failed`                  | 调用失败或输出结构错误，原异常保存在 cause；不会转换成无信号 |

通过 `error instanceof ValueEngineError` 和 `error.code` 识别业务错误，不要匹配 message
文案。构造时的配置校验错误由 Zod 抛出；judgeSession 被取消时优先传播 signal.reason。

## Example 与测试

从仓库根目录运行：

```sh
npm run build -w toy-memory-daily
npm run example -w toy-memory-value
npm test -w toy-memory-value
```

`examples/basic.mjs` 使用真实 LlmRuntime 和显式预设答案的本地 adapter，
无需 API Key 或数据库。它演示插件注册、初始化、反馈强化 R0、正文强化 R7、
双路取大、统一衰减与归档。反馈和 Daily 使用轻量注册槽，仅展示两侧接口装配；
实际应用挂载对应真实服务。

测试覆盖旧版数值回归、反馈证据和纠错优先、模型失败与取消、正文变化、
版本与状态校验、插件注册回滚/卸载，以及 Daily 等待异步概述/细节强化。
预设模型测试验证调用契约与处理规则，不代表真实模型的语义判断准确率。
