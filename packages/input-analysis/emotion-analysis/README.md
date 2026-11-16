# toy-emotion-analysis

情绪分类预处理插件，向 Agent Loop 的 preprocessing 注册名为 `emotion` 的节点，使用 JEV 的 choice
问题。结果 `{ emotion, confidence }` 进入 `preprocessing.data.emotion`。

加载顺序：`toy-jev` → `toy-agent-loop` → `toy-emotion-analysis`。情绪目录在 `emotion-catalog.ts`。
