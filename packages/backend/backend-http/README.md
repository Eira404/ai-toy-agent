# toy-backend-http

后端 HTTP 服务插件：持有路由表并监听本地地址（默认 `127.0.0.1:3000`）。业务插件通过
`ctx.http.route/get/post/put/delete` 注册路径，即可通过 HTTP 调用。

## 用法

```ts
import { Context } from "cordis"
import { HttpServer } from "toy-backend-http"

const ctx = new Context()
await ctx.plugin(HttpServer, { host: "127.0.0.1", port: 3000 })
await ctx.http.ready

ctx.http.post("/sum", (c) => ({ sum: c.body.a + c.body.b }))
```

## 约定

- 请求体按 JSON 解析；路径参数用 `:name` 段，查询串从 `c.query` 读，请求头从 `c.headers` 读（键为小写）。
- 成功响应：`200 { ok: true, data }`（`data` 为 handler 返回值，undefined 归一为 null）。
- 失败响应：`{ ok: false, error: { code, message } }`，状态码由错误 `code` 映射（`invalid-input`→400、`session-not-found`→404、`LLM_ERROR`→502 等），未识别 code 回退 500。
