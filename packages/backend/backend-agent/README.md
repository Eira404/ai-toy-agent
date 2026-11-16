# toy-backend-agent

Agent 后端门面：把会话生命周期、对话调用与读取收敛成统一接口，并以 HTTP 路由注册到
`toy-backend-http`，注册后即可通过 `http://127.0.0.1:port/agentBackend/...` 调用。

依赖通过 `inject = ["session", "sessionData", "http"]` 声明，由开发者按序挂载；本包不建根
Context、不编排、不解析全局配置。

## 路由

| 方法 | 路径 | 说明 |
| ---- | ---- | ---- |
| POST | `/agentBackend/createSession` | 请求体为 `CreateSessionInput`，返回 sessionId |
| GET  | `/agentBackend/getSession/:sessionId` | 读 Session |
| GET  | `/agentBackend/getActiveSession/:userId/:deviceId` | 读 active Session |
| GET  | `/agentBackend/listSessions/:userId/:deviceId` | 分页列表，`?limit=&beforeCreatedAt=&beforeSessionId=` |
| POST | `/agentBackend/closeSession/:sessionId` | 申请关闭 |
| POST | `/agentBackend/runTurn/:sessionId` | 请求体为 `RunTurnInput`，返回 `RunTurnResult` |
| GET  | `/agentBackend/getHistory/:sessionId` | 运行期完整历史 |
| GET  | `/agentBackend/getTurnHistory/:sessionId/:turnId` | 单个 Turn |
| GET  | `/agentBackend/listTurnHistory/:sessionId` | 按 Turn 分页，`?limit=&beforeTurnNo=` |
| POST | `/agentBackend/waitForPostprocessing` | 等待收尾 |
