# toy-admin-backend

管理员 HTTP 后端 Cordis 插件，服务名 `ctx.adminBackend`。它把 `toy-admin` 注册的能力和
`toy-admin-auth` 的账号接口统一挂载到 `toy-backend-http`（默认前缀 `/admin`）。

本包是纯传输适配层：不实现业务，不保存状态，只负责路由同步、凭据提取、输入归一化与错误映射。

## 挂载

依赖 `http`、`admin`、`adminAuth`。宿主先挂载存储、认证、总包和 HTTP 服务，再挂载本包：

```ts
import { Context } from "cordis"
import { ToyStorage } from "toy-storage"
import { RelationalStorage } from "toy-storage-relational"
import { HttpServer } from "toy-backend-http"
import { Admin, adminRelationalSchema } from "toy-admin"
import { AdminAuth, adminAuthRelationalSchema } from "toy-admin-auth"
import { AdminBackendService } from "toy-admin-backend"

const ctx = new Context()
// ……挂载存储与关系型数据源（合并 adminAuth + admin 的 schema）……
await ctx.plugin(AdminAuth, { sourceName: "main" })
await ctx.plugin(Admin, { sourceName: "main" })
await ctx.plugin(HttpServer, { host: "127.0.0.1", port: 3000 })
await ctx.plugin(AdminBackendService, { mountPath: "/admin" }) // mountPath 可省略，默认 /admin
```

## 固定账号/认证端点

直接调用 `ctx.adminAuth`，不走能力注册表。`bootstrap` 保持宿主初始化专用，不暴露为路由。

| 方法 | 路径                                     | 说明                                                    |
| ---- | ---------------------------------------- | ------------------------------------------------------- |
| POST | `/admin/login`                           | 匿名登录，返回 `{ token, sessionId, expiresAt, admin }` |
| POST | `/admin/logout`                          | 退出当前会话                                            |
| GET  | `/admin/me`                              | 当前管理员资料                                          |
| POST | `/admin/change-password`                 | 修改自己的密码                                          |
| POST | `/admin/revoke-my-sessions`              | 撤销自己的全部会话                                      |
| POST | `/admin/admins`                          | 创建管理员（body 为 `CreateAdminInput`）                |
| GET  | `/admin/admins`                          | 分页列表，`?limit=&beforeCreatedAt=&beforeAdminId=`     |
| GET  | `/admin/admins/:adminId`                 | 查询管理员                                              |
| POST | `/admin/admins/:adminId/disable`         | 禁用账号                                                |
| POST | `/admin/admins/:adminId/enable`          | 启用账号                                                |
| POST | `/admin/admins/:adminId/role`            | 调整角色（body `{ role }`）                             |
| POST | `/admin/admins/:adminId/revoke-sessions` | 强制下线                                                |
| POST | `/admin/sessions/cleanup`                | 清理过期会话（body `{ limit? }`）                       |

## 动态能力路由

业务插件通过本包导出的 `httpBinding()` 定义 HTTP 绑定，获得字段补全和运行时校验。
挂载 `AdminBackendService` 后，才会根据元数据在 `mountPath` 下创建真实路由。

```ts
import { httpBinding } from "toy-admin-backend"

ctx.effect(() =>
  ctx.admin.register({
    name: "example.double",
    description: "返回输入整数的两倍",
    roles: ["superadmin", "admin"],
    kind: "query",
    bindings: [httpBinding({ method: "POST", path: "/example/double" })],
    input: {
      type: "object",
      properties: { value: { type: "integer" } },
      required: ["value"],
      additionalProperties: false,
    },
    execute: (input) => ({ doubled: input.value * 2 }),
  }),
)
```

- 绑定 `path` 为相对路径，不含 `/admin` 前缀；本包拼接 `mountPath + path`，示例地址为 `POST /admin/example/double`。
- 本包订阅 `admin/operations-changed`，能力注册/注销时自动增删路由，并按 `registrationId` 对齐注册代次。
- 请求从 `Authorization: Bearer <token>` 提取凭据，随后统一走 `admin.execute`（认证 → 角色 → Schema → 资源检查 → 审计 → 执行）。
- 原始手写绑定仍支持，但经过与 helper 相同的校验，不再静默跳过非法字段。
- 当前只支持 HTTP JSON。`responseMode: "sse"`、opaque 结果不会挂载端点，也不会降级成 JSON。

### 字段怎么填

`transport: "http"` 由 helper 自动填写，使用者明确指定请求方法和相对路径即可：

| 字段           | 可填值与默认行为                                                                   |
| -------------- | ---------------------------------------------------------------------------------- |
| `method`       | 必填，GET、POST、PUT、PATCH、DELETE，由 AdminHttpMethod 和 ADMIN_HTTP_METHODS 定义 |
| `path`         | 必填，例如 `/example/double`，不含主机、端口或 mountPath                           |
| `inputSource`  | 可选，body、query、request；默认 GET=query，其他方法=body                          |
| `responseMode` | 可省略，当前只支持 json，helper 自动补全                                           |

方法和路径是能力提供方设计的访问契约，不是自动发现的内部接口地址。
普通 JSON 输入可用 POST；查询串读取用 GET，并将能力声明为 query。
GET 不能绑定 command 或使用 body 输入。单值查询参数为字符串，重复项为字符串数组，不隐式转换类型。
尚未支持的协议需要真实适配器，不能通过随意修改 transport/responseMode 获得 SSE/WebSocket/gRPC 能力。

路径允许 ASCII 字母数字、`._~-` 静态段和 `:parameter`，尾斜杠会规范化。
拒绝 URL、空段、查询串、fragment、编码路径、通配符、点段、重复或保留参数名。mountPath 不允许参数。

### 混合使用路径参数、查询串与请求体

路径含参数时，必须显式声明完整请求 DTO，防止参数被忽略：

```ts
httpBinding({ method: "PATCH", path: "/items/:itemId", inputSource: "request" })
```

总包接收的业务 DTO 为 `{ params, query, body }`，例如：

```json
{
  "params": { "itemId": "item-1" },
  "query": { "tag": ["a", "b"] },
  "body": { "name": "新名称" }
}
```

能力 input Schema 和 execute 应按此 DTO 定义；字段不会隐式合并，body 不能覆盖路径参数。
没有路径参数时也可显式使用 query 或 body 作为完整 DTO。

### 绑定失败与路由冲突

helper 构造时抛 invalid-definition，便于尽早发现配置错误。
动态注册的手写非法 HTTP 绑定会产生告警，可通过 `ctx.adminBackend.getBindingIssues()` 查询原因，
包含能力名称、注册代次、绑定下标、错误分类与说明，不包含请求或凭据。非 HTTP 绑定交给其他适配器。

同一方法下重复路径、`/items/:id` 与 `/items/count` 等模式重叠会拒绝冲突双方；
固定登录和账号路由优先保留，动态能力不能覆盖。注销冲突项后自动恢复剩余合法绑定。
检查仅涵盖本包管理的路由，宿主仍应将 mountPath 专供本插件使用。
总包保持协议无关，helper、HTTP 输入映射和路径冲突检查都属于本包。

## 错误映射

`AdminError` / `AdminAuthError` 的 `code` 由 `toy-backend-http` 映射为状态码：`unauthenticated`→401、
`forbidden`→403、`operation-not-found`/`admin-not-found`→404、`admin-exists`/`duplicate-operation`/`cancelled`→409、
`busy`/`rate-limited`/`auth-busy`→429、`timeout`→504、`audit-unavailable`→503，其余回退 500。

## 验证

```sh
npm test -w toy-admin-backend
npm run example -w toy-admin-backend
npm run typecheck -w toy-admin-backend
```

example 使用内存数据和随机本机端口，自检后关闭服务，不输出 Token。
测试覆盖 helper 默认值/非法值、类型约束、真实 HTTP 鉴权、输入映射、路由冲突与注销恢复。
