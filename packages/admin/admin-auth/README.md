# toy-admin-auth

管理员账号、登录会话与身份认证 Cordis 插件，服务名为 `ctx.adminAuth`。

本包提供首次管理员初始化、后续账号创建、登录/退出、身份校验、密码修改、账号启停和强制下线。
内置超级管理员、普通管理员和只读管理员三类角色。它不监听端口、不注册 HTTP 路由，也不调用任何业务运维接口。
这里的登录会话与 Agent 对话 Session 无关，管理员账号独立于 debug 用户。

## 挂载

插件依赖 `storage` 与 `storageRelational`。宿主创建连接，并将本包完整 schema 合并到关系型数据源。
数据源必须支持事务；缺少表、字段、主键或必要唯一索引声明时，初始化会失败。

```ts
import { Context } from "cordis"
import { ToyStorage } from "toy-storage"
import { RelationalStorage } from "toy-storage-relational"
import { PostgresStorage } from "toy-storage-postgres"
import { AdminAuth, adminAuthRelationalSchema } from "toy-admin-auth"

const ctx = new Context()
await ctx.plugin(ToyStorage)
await ctx.plugin(RelationalStorage)
await ctx.plugin(PostgresStorage, {
  name: "main",
  connectionString: process.env.DATABASE_URL!,
  createMissing: true,
  schema: {
    tables: {
      // ...宿主其他表
      ...adminAuthRelationalSchema.tables,
    },
  },
})
await ctx.plugin(AdminAuth, { sourceName: "main" })
```

首次部署由**可信宿主初始化流程**调用 `bootstrap`。不要将其映射成公开注册接口；
第二次调用会抛 `already-initialized`，即使先前账号被外部删除，也不会重新开放初始化。

```ts
// 只在显式初始化流程执行，不要每次启动都调用。
const first = await ctx.adminAuth.bootstrap({
  loginName: "owner",
  password: process.env.INITIAL_ADMIN_PASSWORD!,
  displayName: "初始管理员",
})

const login = await ctx.adminAuth.login({
  loginName: "owner",
  password: process.env.INITIAL_ADMIN_PASSWORD!,
})
// 将 login.token 交给客户端妥善保管，不要打印或写入日志。
const identity = await ctx.adminAuth.authenticate(login.token)
console.log(identity.admin.loginName)

await ctx.adminAuth.createAdmin(login.token, {
  loginName: "operator",
  password: process.env.OPERATOR_PASSWORD!,
  role: "admin",
})
await ctx.adminAuth.logout(login.token)
```

## 服务方法

### 角色与权限

| 角色       | 标识         | 能力                                                                         |
| ---------- | ------------ | ---------------------------------------------------------------------------- |
| 超级管理员 | `superadmin` | 创建任意角色；启停、强制下线任意账号；修改等级；清理过期会话                 |
| 普通管理员 | `admin`      | 创建、启停和强制下线只读账号；不能操作同级或超级管理员，不能修改任何账号等级 |
| 只读管理员 | `viewer`     | 查询管理员公开资料、列表                                                     |

三类账号都可以登录/退出、修改自己的密码和撤销自己的全部会话。
`bootstrap` 固定创建 `superadmin`（role 只能省略或指定 superadmin），`createAdmin` 默认创建 `viewer`，
显式传入 `role: "admin"` 或 `role: "superadmin"` 仅限超级管理员。
只读账号不能通过管理接口启停账号、替别人强制下线、调整角色或清理全局会话。

所有管理接口内部执行角色检查；越权返回 `forbidden`，失效凭据返回 `unauthenticated`。
`authorize(token, permission)` 可校验本包的操作权限，支持 `admins.read`、`admins.create`、`admins.manage`、
`admins.roles`、`sessions.cleanup`。普通管理员具有前三项，只读管理员只有 `admins.read`。
`admins.manage` 是操作级权限，**不代表可以管理任意目标**；目标账号的角色限制由具体管理方法在事务内检查。
导出的 `hasAdminPermission(role, permission)` 仅用于权限表查询或界面展示，不能用客户端传来的 role 替代凭据认证。

最后一个启用的超级管理员不能被禁用或降级，即使系统中还有普通/只读管理员；错误码为 `last-superadmin`。
修改等级仅限超级管理员；实际变更会原子更新角色、递增安全版本、撤销全部会话并记录 `set-role` 事件，
目标须重新登录。将角色设置为当前值不撤销会话。以上保护与并发写入共用数据库锁。

除 `bootstrap` 和 `login` 外，调用方传入原始 Token，不接收客户端声称的 adminId/roles 作为操作者身份。
每次受保护调用均重新验证会话与账号；`authenticate` 的返回值是当时的身份快照，不能代替下一次校验。

| 方法                                                      | 行为                                                                                |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `bootstrap(input)`                                        | 仅一次创建首个管理员，返回 `AdminProfile`                                           |
| `login(input)`                                            | 返回 `{ token, sessionId, expiresAt, admin }`，只在这里返回原始 Token               |
| `authenticate(token)`                                     | 返回 `{ admin, sessionId, expiresAt }`；无效/过期/撤销/禁用统一为 `unauthenticated` |
| `authorize(token, permission)`                            | 认证并校验当前角色的操作权限，返回身份快照                                          |
| `getMe(token)`                                            | 返回当前管理员公开资料                                                              |
| `logout(token)`                                           | 撤销当前会话；格式正确但不存在/已撤销的 Token 可重复退出                            |
| `createAdmin(token, input)`                               | 超级管理员创建任意角色；普通管理员只能创建只读账号                                  |
| `getAdmin(token, adminId)`                                | 查询公开资料，不存在返回 `undefined`                                                |
| `listAdmins(token, input?)`                               | 创建时间和 ID 倒序分页，返回 `{ items, nextCursor }`                                |
| `disableAdmin(token, adminId)`                            | 按目标角色限制禁用账号；不能禁用最后一个有效超级管理员                              |
| `enableAdmin(token, adminId)`                             | 启用账号；旧会话不恢复，须重新登录                                                  |
| `changePassword(token, { currentPassword, newPassword })` | 校验旧密码，修改并撤销全部会话，包括调用者会话                                      |
| `revokeMySessions(token)`                                 | 撤销当前账号全部会话，包括调用者会话                                                |
| `revokeAdminSessions(token, adminId)`                     | 强制指定管理员全部下线                                                              |
| `setAdminRole(token, adminId, role)`                      | 超级管理员调整角色，返回更新后的公开资料；变更后撤销目标全部会话                    |
| `cleanupExpiredSessions(token, limit?)`                   | 删除最多 limit 条过期/撤销会话，返回数量；默认 100，最多 1000                       |

创建入参为 `{ loginName, password, displayName?, role? }`：

- 登录名去首尾空白并转小写，规范化后为 3–64 位 ASCII 字母、数字、点、下划线或短横线，首位须为字母或数字。
- 新密码须为 12–128 个 Unicode 字符且最多 512 UTF-8 字节，不裁剪、不进行 Unicode 规范化。
- 显示名默认登录名，显式传入时须非空，最多 100 个 UTF-16 码元。
- `AdminProfile` 只包含 `adminId/loginName/displayName/role/enabled/createdAt/updatedAt/passwordChangedAt`。
- 分页入参为 `{ limit?, before?: { createdAt, adminId } }`，limit 默认 20，最多 100。

## 配置

| 配置                       | 默认值   | 说明                                                   |
| -------------------------- | -------- | ------------------------------------------------------ |
| `sourceName`               | `main`   | 宿主已挂载的关系型实例                                 |
| `sessionTtlMs`             | 8 小时   | 固定有效期；不滑动续期，不发 refresh token             |
| `loginWindowMs`            | 15 分钟  | 登录尝试统计窗口                                       |
| `maxLoginAttempts`         | 5        | 同一规范化登录名在窗口内允许的失败/进行中尝试数        |
| `maxConcurrentPasswordOps` | 2        | 每个插件实例的密码计算并发上限，超过立即抛 `auth-busy` |
| `now`                      | 当前时间 | 测试时钟，`() => string`                               |

登录错误对未知账号、密码错误和禁用账号统一为 `invalid-credentials`，未知账号仍进行同规格密码计算。
限流对未知账号同样有效，使用数据库记录，重启和多实例共享。开始计算前预占尝试额度，避免并发请求越过上限；
成功和 `auth-busy` 不占失败额度，但成功登录不会清除此前窗口内的失败。被拒绝的请求抛 `rate-limited`。
进程在计算期间退出会留下 `pending` 事件，在统计窗口内保守计为一次尝试。

## 存储与一致性

| 表                          | 用途                                                                                |
| --------------------------- | ----------------------------------------------------------------------------------- |
| `toy_admin_accounts`        | 管理员资料、角色、密码哈希、安全版本；规范化登录名唯一                              |
| `toy_admin_sessions`        | 32 字节随机 Token 的 SHA-256 摘要、所属账号、安全版本、创建/过期/撤销时间；摘要唯一 |
| `toy_admin_auth_state`      | 固定主键单例，持久化 bootstrap 标记，并通过事务内更新获取全局写锁                   |
| `toy_admin_security_events` | 登录尝试和账号安全变更记录，同时作为登录尝试统计依据                                |

所有安全写入同步落库，不通过异步写入队列。写事务先更新同一状态行获取写锁，再读取身份并修改账号，
从而跨实例串行化初始化、账号启停、密码修改与会话发放。adapter 必须正确实现 `read-committed`、
`repeatable-read` 和事务期间的行写锁；当前 PostgreSQL adapter 支持这些语义。
这是一套面向低流量管理员认证的实现，写事务串行，不作为高吞吐用户登录系统使用。

密码计算在事务外进行，写入前再次验证身份、角色和安全版本。强制下线、禁用、修改密码和变更等级均递增安全版本，
所以已经开始校验旧密码的登录请求也不能在变更后发放新 Token。
只读身份校验使用可重复读事务；与撤销并发的校验可能按撤销前快照完成，变更提交后的新调用会拒绝旧会话。

密码使用 Node.js 异步 `scrypt`，参数 `N=32768, r=8, p=3`，随机盐 16 字节，结果 32 字节，使用恒定时间比较。
参数依据 [OWASP Password Storage](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html#scrypt)，
内存上限依据 [Node.js crypto.scrypt](https://nodejs.org/api/crypto.html#cryptoscryptpassword-salt-keylen-options-callback) 设置为 64 MiB。

安全事件不包含密码、原始 Token 或请求体。登录名在尝试事件中只记 SHA-256 摘要（可关联、并非匿名化），
其他事件记录操作者、目标账号、动作、结果和发生时间。账号安全变更及成功事件在同一事务中提交，记录失败则全部回滚。
底层数据库错误原样传播；尤其 `unknown-commit-state` 不自动重试，需宿主核对状态。

## 边界

- 宿主负责 HTTP 凭据提取、TLS、Cookie/CSRF 策略、来源 IP 限流及整体请求并发控制。
- 同进程插件属于可信代码；本包不隔离恶意插件，也不负责保护绕过认证的其他 HTTP 路由。
- 不提供公开注册、密码找回、管理员替别人重置密码、邀请邮件、MFA 或自定义角色/权限配置。
- 不自动挂载到 `apps/backend`，不读取 `.env`，不自动创建管理员或注册定时任务。
- 安全事件保留与清理由宿主制定策略；不要删除统计窗口内的登录尝试，否则会削弱限流。
- 停机前由宿主等待在途调用结束，再卸载插件与数据源。

## 从无角色版本升级

新数据库直接使用最新 `adminAuthRelationalSchema`。已有表需要先执行
[`migrations/001-admin-roles.sql`](./migrations/001-admin-roles.sql)，`createMissing: true` 不会给旧表添加字段。
本包不自动迁移，也不会将缺失/未知角色默认为超级管理员。

迁移前停止所有旧版本实例，在同一 PostgreSQL 连接中选定目标 schema 和一个确认过的启用账号：

```sql
SET search_path TO your_schema;
SELECT admin_id, login_name, enabled FROM toy_admin_accounts;
SET toy.admin_superadmin_id = '选定的启用账号 ID';
-- 然后在同一连接中执行 migrations/001-admin-roles.sql 的完整内容。
```

脚本在一个事务内新增 role 字段，将所选账号设为 `superadmin`、其他历史账号设为 `viewer`，
撤销全部旧会话并递增安全版本。之后须重新登录，由超级管理员按需授予普通管理员或其他超级管理员身份。
账号表非空但未指定有效启用账号时，迁移整体回滚；空账号表允许直接迁移，之后按原规则 bootstrap。
脚本只用于从无角色版本升级，不能重复执行。

## 验证

```sh
npm test -w toy-admin-auth
npm run typecheck -w toy-admin-auth
npm run example -w toy-admin-auth
# 使用根目录 .env 中的 DATABASE_URL，仅操作本次创建的独立临时 schema
npm run test:live -w toy-admin-auth
```

单元测试使用支持回滚、唯一约束与事务串行化的内存测试 adapter。
示例复用该测试替身，不连接网络、不打印原始凭据。
实库验证使用两个独立 Cordis 根 Context/连接池，检查并发初始化、并发禁用保护、跨实例限流、会话撤销和持久化重载，
结束后只删除本次生成的 schema。
