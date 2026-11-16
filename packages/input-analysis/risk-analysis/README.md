# toy-risk-analysis

风险分析预处理插件，向 Agent Loop 的 preprocessing 注册名为 `risk` 的节点，用多个 JEV noul 问题
筛选命中风险类别，再投影 context/level。结果 `{ categories, context, level }` 进入
`preprocessing.data.risk`。

加载顺序：`toy-jev` → `toy-agent-loop` → `toy-risk-analysis`。类别/上下文/等级目录在
`risk-catalog.ts`。
