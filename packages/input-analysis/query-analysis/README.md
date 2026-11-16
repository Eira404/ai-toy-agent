# toy-query-analysis

Query 改写与一级领域分析预处理插件，向 Agent Loop 的 preprocessing 注册名为 `queryAnalysis` 的
节点（LLM + JSON Schema）。结果 `{ rewrittenQuery, primaryDomain, secondaryDomains }` 进入
`preprocessing.data.queryAnalysis`。

导出 `PRIMARY_DOMAIN_CATALOG`、`PRIMARY_DOMAIN_NAMES`、`PrimaryDomain` 和 `QueryAnalysisResultSchema`，
供 `toy-subdomain-analysis` 复用。加载顺序：`toy-llm` → `toy-agent-loop` → `toy-query-analysis`。
