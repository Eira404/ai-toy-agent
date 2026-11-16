# Go 记忆系统 · 管理员后端 API 文档

> 目标读者：前端/LLM。本文档自包含，覆盖鉴权、账号管理与记忆运维的全部 HTTP 接口，
> 可直接据此实现管理端页面。

---

## 1. 基础约定

- **Base URL**：`http://<HOST>:<PORT>`，默认 `http://127.0.0.1:3200`。
- **统一挂载前缀**：默认 `/admin`（可通过环境变量 `ADMIN_MOUNT_PATH` 改变，下文以 `/admin` 为例）。
- **鉴权方式**：除 `POST /admin/login` 外，所有接口都需要请求头：

  ```
  Authorization: Bearer <token>
  ```

  `token` 由登录接口返回。

- **响应信封**（所有接口统一）：

  - 成功（HTTP 200）：

    ```json
    { "ok": true, "data": <结果> }
    ```

  - 失败（HTTP 4xx/5xx）：

    ```json
    { "ok": false, "error": { "code": "<稳定错误码>", "message": "<可读信息>" } }
    ```

  前端判断成功/失败看 `ok` 字段；错误详情看 `error.code` / `error.message`。

- **请求体**：JSON（`Content-Type: application/json`）。
- **时间格式**：ISO 8601 字符串，如 `2026-11-15T10:00:00.000Z`。
- **分页游标**：见各接口说明。

---

## 2. 认证接口

### 2.1 登录

```
POST /admin/login
```

**请求体**：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `loginName` | string | 是 | 登录名（3–64 位字母/数字/`.`/`_`/`-`） |
| `password` | string | 是 | 密码（12–128 字符） |

**响应 `data`**：

```json
{
  "token": "……",
  "sessionId": "……",
  "expiresAt": "2026-11-16T06:00:00.000Z",
  "admin": {
    "adminId": "……",
    "loginName": "admin",
    "displayName": "管理员",
    "role": "superadmin",
    "enabled": true,
    "createdAt": "2026-11-15T10:00:00.000Z",
    "updatedAt": "2026-11-15T10:00:00.000Z",
    "passwordChangedAt": "2026-11-15T10:00:00.000Z"
  }
}
```

> `token` 即后续所有请求的 Bearer 凭据。会话固定 8 小时有效，不滑动续期。

### 2.2 当前登录者

```
GET /admin/me        （需 Bearer）
```

**响应 `data`**（`AdminIdentity`）：

```json
{
  "admin": { "adminId": "……", "loginName": "admin", "displayName": "管理员", "role": "superadmin", "enabled": true, "createdAt": "……", "updatedAt": "……", "passwordChangedAt": "……" },
  "sessionId": "……",
  "expiresAt": "……"
}
```

### 2.3 修改自己的密码

```
POST /admin/change-password        （需 Bearer）
```

**请求体**：`{ "currentPassword": "……", "newPassword": "……" }`

### 2.4 登出当前会话

```
POST /admin/logout        （需 Bearer）
```

### 2.5 退出自己的所有会话

```
POST /admin/revoke-my-sessions        （需 Bearer）
```

---

## 3. 账号管理接口（admin / superadmin）

### 3.1 账号列表（分页）

```
GET /admin/admins        （需 Bearer）
```

**Query 参数**：

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `limit` | int | 否 | 每页条数，默认 20 |
| `beforeCreatedAt` | string | 否 | 游标时间，与 `beforeAdminId` 成对 |
| `beforeAdminId` | string | 否 | 游标 ID，与 `beforeCreatedAt` 成对 |

**响应 `data`**：

```json
{
  "items": [
    { "adminId": "……", "loginName": "admin", "displayName": "管理员", "role": "superadmin", "enabled": true, "createdAt": "……", "updatedAt": "……", "passwordChangedAt": "……" }
  ],
  "nextCursor": { "createdAt": "……", "adminId": "……" }
}
```

> `nextCursor` 字段缺省（响应中不存在）表示没有下一页。

### 3.2 创建账号

```
POST /admin/admins        （需 Bearer）
```

**请求体**：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `loginName` | string | 是 | 同登录名规则 |
| `password` | string | 是 | 同密码规则 |
| `displayName` | string | 否 | 显示名 |
| `role` | string | 否 | `viewer`(默认) / `admin` / `superadmin`；普通 admin 只能建 `viewer` |

**响应 `data`**：新建账号的 `AdminProfile`（结构见 2.1 的 `admin` 字段）。

### 3.3 账号详情 / 停用 / 启用 / 改角色 / 强制下线

```
GET    /admin/admins/:adminId             （需 Bearer）→ AdminProfile
POST   /admin/admins/:adminId/disable     （需 Bearer）
POST   /admin/admins/:adminId/enable      （需 Bearer）
POST   /admin/admins/:adminId/role        （需 Bearer） body: { "role": "viewer|admin|superadmin" }
POST   /admin/admins/:adminId/revoke-sessions （需 Bearer）
```

> `:adminId` 是 URL 路径参数。

### 3.4 清理过期会话

```
POST /admin/sessions/cleanup        （需 Bearer，superadmin）
```

**请求体**：`{ "limit": 100 }`（正整数，缺省 100）。

---

## 4. 记忆运维接口（核心）

> 这些接口走 GET + **query 参数**（不是路径参数），所有值以字符串到达。

### 4.1 已有用户（userId）列表

```
GET /admin/memory/users        （viewer/admin/superadmin）
```

**Query 参数**：

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `limit` | int | 否 | 每页条数，1–100，默认 20 |
| `before` | string | 否 | 上一页最后一个 `userId` |

**响应 `data`**：

```json
{
  "items": [ { "userId": "u_001" }, { "userId": "u_002" } ],
  "nextCursor": "u_002"
}
```

> `nextCursor` 是字符串（最后一个 userId），翻下一页时作为 `before` 回传；缺省表示没有下一页。

### 4.2 某用户下的娃娃与记忆空间

```
GET /admin/memory/user-overview        （viewer/admin/superadmin）
```

**Query 参数**：

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `userId` | string | 是 | 用户 ID |
| `includeDeleted` | string | 否 | `"true"` 时包含已软删除空间，缺省只返回 active |

**响应 `data`**：

```json
{
  "userId": "u_001",
  "devices": [
    { "userId": "u_001", "deviceId": "dev_001", "memorySpaceId": "sp_001", "createdAt": "……" }
  ],
  "spaces": [
    { "memorySpaceId": "sp_001", "userId": "u_001", "name": "玩具A", "status": "active", "createdAt": "……", "updatedAt": "……" }
  ]
}
```

### 4.3 Fast 记忆列表（按空间分页）

```
GET /admin/memory/fast        （admin/superadmin）
```

**Query 参数**：

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `memorySpaceId` | string | 是 | 记忆空间 ID |
| `limit` | int | 否 | 每页条数，1–100，默认 20 |
| `beforeCreatedAt` | string | 否 | 游标时间，与 `beforeFastId` 成对 |
| `beforeFastId` | string | 否 | 游标 ID，与 `beforeCreatedAt` 成对 |
| `pendingOnly` | string | 否 | `"true"` 只看未消费记录，缺省返回全部 |

**响应 `data`**：

```json
{
  "items": [
    {
      "fastId": "……",
      "writeId": "……",
      "userId": "u_001",
      "memorySpaceId": "sp_001",
      "sessionId": "……",
      "turnId": "……",
      "createdAt": "2026-11-15T10:00:00.000Z",
      "title": "喜欢蓝色的积木",
      "titleKey": "喜欢蓝色的积木",
      "summary": "孩子喜欢蓝色的积木",
      "body": "- 喜欢蓝色积木\n- 常用来搭高塔",
      "consumedBatchId": null,
      "consumedAt": null
    }
  ],
  "nextCursor": { "createdAt": "……", "fastId": "……" },
  "total": 42,
  "pending": 7,
  "consumed": 35
}
```

> `nextCursor` 为对象 `{ createdAt, fastId }`；翻页时把两个字段原样作为 `beforeCreatedAt` / `beforeFastId` 回传。
> `total` / `pending` / `consumed` 是整数计数（全部 / 未消费 / 已消费）。

### 4.4 Fast 记忆详情

```
GET /admin/memory/fast-detail        （admin/superadmin）
```

**Query 参数**：`memorySpaceId`（是）、`fastId`（是）

**响应 `data`**：单条 `FastRecord`（结构见 4.3 的 `items[]` 元素）。

### 4.5 Long 记忆块列表（按空间分页）

```
GET /admin/memory/long        （admin/superadmin）
```

**Query 参数**：

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `memorySpaceId` | string | 是 | 记忆空间 ID |
| `limit` | int | 否 | 每页条数，1–100，默认 20 |
| `beforeSortAt` | string | 否 | 游标时间，与 `beforeBlockId` 成对 |
| `beforeBlockId` | string | 否 | 游标 ID，与 `beforeSortAt` 成对 |
| `domain` | string | 否 | `self`/`person`/`project`/`topic`/`entity`/`event` |
| `lifecycle` | string | 否 | `active`/`observing`/`archived` |
| `orderBy` | string | 否 | `updatedAt`(默认)/`createdAt` |

**响应 `data`**：

```json
{
  "items": [
    {
      "blockId": "……",
      "domain": "person",
      "title": "妈妈",
      "aliases": ["母亲", "mama"],
      "summary": "孩子对妈妈的认知",
      "lifecycleStatus": "active",
      "updatedAt": "2026-11-15T10:00:00.000Z"
    }
  ],
  "nextCursor": { "sortAt": "……", "blockId": "……" },
  "total": 12
}
```

> `nextCursor` 为对象 `{ sortAt, blockId }`；翻页时把两个字段原样作为 `beforeSortAt` / `beforeBlockId` 回传。

### 4.6 Long 记忆块详情

```
GET /admin/memory/long-detail        （admin/superadmin）
```

**Query 参数**：`memorySpaceId`（是）、`blockId`（是）

**响应 `data`**（完整块，含全部细节与价值状态）：

```json
{
  "blockId": "……",
  "domain": "person",
  "title": "妈妈",
  "aliases": ["母亲", "mama"],
  "summary": "孩子对妈妈的认知",
  "overviewBody": "当前对妈妈的概括……",
  "lifecycleStatus": "active",
  "value": { "valueData": { "i": 0.9, "s": 0.8, "p": 0.5, "a": 0.2 }, "valueVersion": "v1" },
  "details": [
    {
      "detailId": "……",
      "summary": "妈妈喜欢做饭",
      "body": "……",
      "lifecycleStatus": "active",
      "value": { "valueData": { "i": 0.7, "s": 0.6 }, "valueVersion": "v1" },
      "createdAt": "……",
      "updatedAt": "……"
    }
  ],
  "createdAt": "……",
  "updatedAt": "……",
  "contentUpdatedAt": "……"
}
```

> `value.valueData` 是任意 JSON（价值遗忘系统私有结构，前端只展示或忽略，不要解析其语义）。

---

## 5. 数据模型（字段速查）

### AdminProfile（账号）

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `adminId` | string | 账号 ID |
| `loginName` | string | 登录名 |
| `displayName` | string | 显示名 |
| `role` | string | `superadmin` / `admin` / `viewer` |
| `enabled` | boolean | 是否启用 |
| `createdAt` / `updatedAt` / `passwordChangedAt` | string | 时间 |

### MemorySpace（记忆空间）

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `memorySpaceId` | string | 空间 ID |
| `userId` | string | 所有者 userId |
| `name` | string \| null | 空间名 |
| `status` | string | `active` / `deleted`（软删除） |
| `createdAt` / `updatedAt` | string | 时间 |

### DeviceBinding（娃娃绑定）

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `userId` | string | 用户 |
| `deviceId` | string | 娃娃（玩偶）设备 ID |
| `memorySpaceId` | string | 绑定到的空间 |
| `createdAt` | string | 绑定时间 |

### FastRecord（Fast 记忆）

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `fastId` | string | 记录 ID |
| `writeId` | string | 写入批次 ID |
| `userId` / `memorySpaceId` | string | 归属 |
| `sessionId` / `turnId` | string | 来源会话/轮次 |
| `createdAt` | string | 创建时间 |
| `title` / `titleKey` | string | 标题 / 规范化标题键 |
| `summary` | string | 语义检索摘要 |
| `body` | string | 完整正文（Markdown） |
| `consumedBatchId` / `consumedAt` | string \| null | 已被 Daily 消费的批次/时间 |

### LongBlockSummary（Long 块摘要，列表用）

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `blockId` | string | 块 ID |
| `domain` | string | 见下方枚举 |
| `title` | string | 标题 |
| `aliases` | string[] | 别名 |
| `summary` | string | 摘要 |
| `lifecycleStatus` | string | `active` / `observing` / `archived` |
| `updatedAt` | string | 更新时间 |

### LongBlock（Long 块详情）

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `blockId` / `domain` / `title` / `aliases` / `summary` / `lifecycleStatus` | — | 同摘要 |
| `overviewBody` | string | 当下概括正文 |
| `value` | `{ valueData: any, valueVersion: string }` | 价值状态（opaque） |
| `details` | LongDetail[] | 细节列表 |
| `createdAt` / `updatedAt` / `contentUpdatedAt` | string | 时间 |

### LongDetail（Long 细节）

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `detailId` | string | 细节 ID |
| `summary` / `body` | string | 摘要 / 正文 |
| `lifecycleStatus` | string | 生命周期 |
| `value` | `{ valueData: any, valueVersion: string }` | 价值状态 |
| `createdAt` / `updatedAt` | string | 时间 |

### 枚举

- `domain`：`self` | `person` | `project` | `topic` | `entity` | `event`
- `lifecycleStatus`：`active` | `observing` | `archived`
- `role`：`superadmin` | `admin` | `viewer`

---

## 6. 权限模型

| 角色 | 记忆运维（元信息） | 记忆运维（正文） | 账号管理 |
| --- | --- | --- | --- |
| `viewer` | users、user-overview 可读 | 无权限 | 只读（admins 列表/详情） |
| `admin` | 可读 | fast/long 列表与详情可读 | 可建/停用/启用账号，但只能操作 `viewer`，不能改角色 |
| `superadmin` | 可读 | 可读 | 全部（含改角色、清理会话） |

---

## 7. 错误码速查（`error.code` → HTTP 状态）

| code | HTTP | 含义 |
| --- | --- | --- |
| `unauthenticated` / `invalid-credentials` | 401 | 未认证 / 凭据错误 |
| `forbidden` | 403 | 无权限 |
| `invalid-input` / `invalid-json` | 400 | 参数错误 / 请求体非 JSON |
| `operation-not-found` / `admin-not-found` / `not-found` | 404 | 资源/路由不存在 |
| `admin-exists` / `already-initialized` / `last-superadmin` / `duplicate-operation` | 409 | 冲突 |
| `rate-limited` / `auth-busy` / `busy` | 429 | 限流 / 忙碌 |
| `timeout` | 504 | 调用超时 |
| `source-not-ready` / `audit-unavailable` | 503 | 后端依赖不可用 |
| `execution-failed` / `invalid-output` / `schema-mismatch` 等 | 500 | 服务端错误 |

---

## 8. 前端实现建议（给 LLM 的提示）

1. 登录后把 `token` 存起来，所有请求统一带 `Authorization: Bearer <token>`。
2. 401 时跳转登录页；403 时按角色隐藏/禁用按钮。
3. 列表页统一用「游标分页」：把上次响应的 `nextCursor` 原样回传即可翻下一页，无需计算 offset。
4. `list-users` → 点某用户 → `user-overview`（拿到 spaces/devices）→ 点某空间 → `list-fast` / `list-long` → 点某条 → `fast-detail` / `long-detail`。
5. `value.valueData` 是任意 JSON，仅做 JSON 树展示（如 `JSON.stringify(..., null, 2)`），不要解析其字段含义。
