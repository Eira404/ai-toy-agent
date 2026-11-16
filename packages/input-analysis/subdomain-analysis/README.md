# toy-subdomain-analysis

子领域打分预处理插件，向 Agent Loop 的 preprocessing 注册名为 `subdomain` 的节点。它通过
`dependsOn: ["queryAnalysis"]` + `upstream.queryAnalysis` 依赖 Query 分析的一级领域，再用 JEV score
问题对候选子领域打分。结果 `{ subdomains }` 进入 `preprocessing.data.subdomain`。

加载顺序：`toy-jev` → `toy-llm` → `toy-agent-loop` → `toy-query-analysis` → `toy-subdomain-analysis`。
子领域目录在 `subdomain-catalog.ts`。
