# toy-debug-backend

Debug 后端门面：把 `toy-debug-user` / `toy-debug-device` 里的用户/设备 debug 操作注册为 `/debug/*` HTTP 路由，挂载到 `ctx.debugBackend`。它只转发 `ctx.debugUsers` 与 `ctx.debugDevices`，不建根 Context、不编排。

## 依赖链

`HttpServer` + `DebugUsers` + `DebugDevices` 必须先挂载；随后挂载本插件即可注册路由。

```js
import { Context } from "cordis"
import { HttpServer } from "toy-backend-http"
import { DebugUsers } from "toy-debug-user"
import { DebugDevices } from "toy-debug-device"
import { DebugBackendService } from "toy-debug-backend"

const ctx = new Context()
// …存储插件与命名关系型 adapter（含 debug 表）先挂载…
await ctx.plugin(DebugUsers, { sourceName: "main" })
await ctx.plugin(DebugDevices, { sourceName: "main" })
await ctx.plugin(HttpServer, { host: "127.0.0.1", port: 3000 })
await ctx.plugin(DebugBackendService)
await ctx.http.ready
```

## 路由

用户：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/debug/createUser` | 创建用户，body 为 `CreateUserInput` |
| POST | `/debug/ensureUser` | 确保存在，body 为 `CreateUserInput` |
| POST | `/debug/seedUsers` | 批量确保，body 为 `CreateUserInput[]` |
| GET | `/debug/getUser/:userId` | 读取用户 |
| GET | `/debug/listUsers` | 分页，query：`limit`、`beforeCreatedAt`、`beforeUserId` |
| POST | `/debug/updateUser/:userId` | 更新，body 为 `UpdateUserInput` |
| DELETE | `/debug/deleteUser/:userId` | 删除 |

设备：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/debug/createDevice` | 创建设备，body 为 `CreateDeviceInput` |
| POST | `/debug/ensureDevice` | 确保存在，body 为 `CreateDeviceInput` |
| POST | `/debug/seedDevices` | 批量确保，body 为 `CreateDeviceInput[]` |
| GET | `/debug/getDevice/:deviceId` | 读取设备 |
| GET | `/debug/listDevices` | 分页，query：`userId`、`limit`、`beforeCreatedAt`、`beforeDeviceId` |
| POST | `/debug/updateDevice/:deviceId` | 更新，body 为 `UpdateDeviceInput` |
| DELETE | `/debug/deleteDevice/:deviceId` | 删除 |

成功响应形如 `{ ok: true, data: … }`，失败响应形如 `{ ok: false, error: { code, message } }`。
