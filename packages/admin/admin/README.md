# toy-admin

管理员总包 Cordis 插件，服务名 `ctx.admin`。提供能力注册/注销、身份及角色检查、输入/结果校验、
业务分发、安全能力描述、持久化调用审计，以及当前调用的取消/等待管理。

本包保存 backend 所需的绑定元数据，不监听端口、不创建 HTTP/SSE/WebSocket/gRPC 接口、不解释路由冲突。
任务 ID、状态、进度和恢复属于业务/通用任务服务；返回事件源后由 backend 消费和发送，总包不运行它。
HTTP JSON 适配已由兄弟包 `toy-admin-backend` 提供；本包不自动挂载网络插件或真实运维能力。

## 挂载

依赖 `adminAuth`、`storage`、`storageRelational`。宿主组合 schema 和连接，先挂载认证插件，再挂载总包。
本包核对 adapter 的逻辑表/字段声明，不执行物理建表或迁移。初始化缺少审计表时拒绝工作。

```ts
import { Context } from "cordis"
import { ToyStorage } from "toy-storage"
import { RelationalStorage } from "toy-storage-relational"
import { PostgresStorage } from "toy-storage-postgres"
import { AdminAuth, adminAuthRelationalSchema } from "toy-admin-auth"
import { Admin, adminRelationalSchema } from "toy-admin"

const ctx = new Context()
await ctx.plugin(ToyStorage)
await ctx.plugin(RelationalStorage)
await ctx.plugin(PostgresStorage, {
  name: "main",
  connectionString: process.env.DATABASE_URL!,
  createMissing: true,
  schema: {
    tables: {
      ...adminAuthRelationalSchema.tables,
      ...adminRelationalSchema.tables,
    },
  },
})
await ctx.plugin(AdminAuth, { sourceName: "main" })
await ctx.plugin(Admin, { sourceName: "main" })
```

管理员初始化、登录、密码和角色管理直接使用 `ctx.adminAuth`，见兄弟包文档。
总包仅调用 `authenticate(token)` 取得当前身份，再按业务能力自己的 roles 检查。
账号管理固定权限不会被误用来代表任意业务管理权限。

## 注册能力

```ts
interface DoubleInput {
  readonly value: number
}
interface DoubleOutput {
  readonly doubled: number
}

// 放在提供能力插件的构造/生命周期中，确保提供方卸载时注销。
ctx.effect(() =>
  ctx.admin.register<DoubleInput, DoubleOutput>({
    name: "example.double",
    description: "返回输入整数的两倍",
    roles: ["superadmin", "admin"],
    kind: "query",
    bindings: [{ transport: "http", method: "POST", path: "/example/double" }],
    input: {
      type: "object",
      properties: { value: { type: "integer" } },
      required: ["value"],
      additionalProperties: false,
    },
    output: {
      type: "object",
      properties: { doubled: { type: "integer" } },
      required: ["doubled"],
      additionalProperties: false,
    },
    audit: () => ({ sample: true }),
    execute: (input, context) => ({ doubled: input.value * 2 }),
  }),
)
```

| 字段                        | 含义                                                                        |
| --------------------------- | --------------------------------------------------------------------------- |
| `name`                      | 1–128 位，首段字母开头，各段由字母数字下划线短横线组成，以点分段；全局唯一  |
| `description`               | 非空说明，最多 2000 个 UTF-16 码元                                          |
| `roles`                     | 非空 `superadmin/admin/viewer` 白名单，去重；没有隐式超级管理员绕过         |
| `kind`                      | `query` 或 `command`；业务 command 不能包含 viewer                          |
| `bindings`                  | 非空 JSON 对象数组，每项必须含非空 transport，具体字段由 backend 验证和解释 |
| `input`                     | 必填，同步 JSON Schema draft-07；输入为协议无关业务 DTO                     |
| `output`                    | 可选，普通结果 Schema                                                       |
| `resultKind`                | 默认 value（JSON），opaque 原样交付句柄/事件源，不能同时声明 output         |
| `authorize(input, context)` | 可选，无副作用的额外资源检查；false 拒绝，true/undefined 允许，抛错则不执行 |
| `execute(input, context)`   | 同步或异步业务方法；不接收 Token、原始 socket 或 HTTP response              |
| `audit(input, context)`     | 可选，显式安全摘要，默认不保存输入或输出                                    |
| `timeoutMs`                 | 可选，从调用开始计算的等待期限，受 maxTimeoutMs 限制                        |

名称、角色、绑定、Schema 和回调引用固定在注册时。元数据和 DTO 复制并冻结，注册后修改原对象不改变定义。
Schema 不强制根为 object，可验证任意 JSON DTO；不隐式转换类型、补默认值或删除额外字段。
为拒绝额外字段，应显式写 `additionalProperties: false`。引用只支持当前定义内的 `#`，不加载远程 Schema。
JSON 值不允许循环、自定义类、getter、稀疏数组、undefined 字段、NaN/Infinity，嵌套深度最多 64。
泛型只表达编译时约定；按动态能力名调用时仍以 Schema 的运行时校验为准。

**网络边界**：HTTP 方法/path、SSE 格式、WebSocket channel、gRPC service/proto 及重复 URL 判断由 backend 处理。
本包只核对 bindings 是可序列化元数据，不检查某个协议是否安装；同一 URL 的不同能力可注册，适配层必须拒绝冲突绑定。
不要在 bindings、说明或 Schema 示例中保存密钥等秘密，因为能力描述可供有权管理员查看。

接入已实现的 `toy-admin-backend` 时，建议使用它提供字段提示和校验：

```ts
import { httpBinding } from "toy-admin-backend"

// 放入能力定义的 bindings；自动填写 transport、默认输入来源和 JSON 响应模式。
const bindings = [httpBinding({ method: "POST", path: "/example/double" })]
```

具体字段、路径参数输入和挂载诊断见 [admin-backend README](../admin-backend/README.md)。
本包独立 example 保留原始元数据写法，不因此依赖 HTTP 插件。SSE/WebSocket/gRPC 适配尚未提供。

## 调用与执行上下文

```ts
// token 来自 ctx.adminAuth.login 的结果，由可信适配层提取，不打印或写入日志。
const result = await ctx.admin.execute<DoubleOutput, DoubleInput>("example.double", {
  token,
  input: { value: 21 },
  requestId: "request-from-adapter",
  // expectedRegistrationId: 从 handler 创建时的能力描述取得，防止旧路由调用同名新项
  // signal: 请求调用的取消信号
})
```

流程：认证 → 查当前注册项/代次 → 角色 → JSON 快照/输入 Schema → 资源检查 → 安全摘要/开始审计
→ 重新认证并确认注册项仍有效 → execute → 普通结果校验 → 结束审计。
后一次认证用于防止前置异步等待期间会话被撤销或角色被调整。
资源数据的最终事务一致性、幂等和互斥仍由原业务服务保证，authorize 的读取不代替业务提交时约束。

context 包含 `executionId/requestId/operationName/identity/signal`。
identity 是当次可信只读快照，原始 Token 不交给业务回调。输入中的 adminId/role 只属于业务数据，不能替代操作者身份。
外部返回错误经过安全包装；提供方若主动抛 `AdminError`，须自行保证 message 可公开且不含秘密。

普通结果复制为冻结 JSON，undefined 归一为 null；output 验证失败可能发生在副作用已经完成之后。
opaque 句柄原样返回，不克隆、不消费、不调用 iterator.return、不管理后续订阅，不检查逐事件 Schema。
提供方与 backend 自行约定事件结构、消费/清理和持续授权；若调用超时未交付句柄，提供方也须根据 signal 清理资源。

## 服务方法与生命周期

| 方法                                   | 用途                                                                      |
| -------------------------------------- | ------------------------------------------------------------------------- |
| `register<I, O>(definition)`           | 返回幂等注销函数；由提供方 `ctx.effect` 持有                              |
| `execute<O, I>(name, options)`         | 所有受保护管理调用入口，返回 Promise                                      |
| `listOperations(token)`                | 当前角色可见的冻结能力列表；不代表任意目标资源都被允许                    |
| `describeOperation(token, name)`       | 当前角色可见的单项元数据；不可见为 forbidden                              |
| `getRegistrySnapshot()`                | 可信 backend 的完整 `{ revision, operations }` 快照；不能直接暴露给客户端 |
| `stop()`                               | 永久停止接收新 execute，保留在途调用；幂等                                |
| `waitForIdle({ signal?, timeoutMs? })` | 等待在途 execute 和其审计收尾；不等待已返回的任务/事件源                  |

注册和注销通过 `admin/operations-changed` 发布冻结全量快照，revision 递增。
异步监听器可能乱序完成，适配层必须使用 revision 对齐；监听失败仅记录固定警告，不回滚注册或放宽权限。
注销时取消本代尚未返回的调用，旧 disposer 不会删除后来同名的新项。
backend 的旧 handler 应传 expectedRegistrationId；不得直接缓存执行函数绕过 execute。

优雅停机顺序：先由宿主停止网络接入，再 `ctx.admin.stop()`，`await ctx.admin.waitForIdle(...)`，
最后卸载能力插件、总包、admin-auth 和数据库。直接卸载总包会拒绝新调用并通知在途取消，不能强制停止不合作的业务代码。

## 超时、取消与错误

超时/外部取消/提供方注销仅停止等待并向当前调用传递取消信号。
总包继续观察原 Promise，直到真正结束才释放并发容量并结算审计，不自动重试，也不创建后台任务队列。
`waitForIdle` 超时只停止本次等待。若业务永不结束，容量会一直占用，宿主需要决定停止进程或修复业务。

`AdminError` 包含稳定 code、executionId 和 executionState：

| executionState | 含义                                                 |
| -------------- | ---------------------------------------------------- |
| not-started    | 业务 execute 未被调用                                |
| unknown        | 业务已开始但结果未确认，或数据库报告未知提交状态     |
| succeeded      | execute 已返回，不代表 opaque 后续流或独立任务已结束 |
| failed         | execute 已抛错；可能存在部分副作用，不代表事务回滚   |

错误码包括 invalid-definition、invalid-schema、duplicate-operation、invalid-input、invalid-output、
unauthenticated、forbidden、operation-not-found、operation-unavailable、source-not-ready、schema-mismatch、
busy、timeout、cancelled、execution-failed、audit-unavailable、audit-incomplete。
backend 自行转换成 HTTP/gRPC/WebSocket 错误，不直接序列化 Error.cause 或原始堆栈。

## 审计

导出 `adminRelationalSchema` 和表名 `ADMIN_OPERATIONS_TABLE`（toy_admin_operations）。
记录 execution/request/registration ID、能力名、身份/角色、kind、时间、耗时、调用状态、业务执行状态、等待状态和错误码。
只保存显式 audit 摘要，默认 null；不保存 Token、Session 凭据、密码、完整请求/结果或原始异常消息。
摘要拒绝嵌套敏感键（password/token/secret/authorization/cookie/credential/apiKey 等）及过大 JSON。
该检查不能识别普通字符串里的秘密，提供方仍须只挑选适合记录的业务字段。

开始或前置拒绝审计写入失败返回 audit-unavailable，不启动业务。
结束审计失败返回 audit-incomplete，并携带实际执行状态及 executionId；副作用不会被总包回滚。
数据库在提交附近断线时，审计本身也可能已经写入；应按 executionId 查询核对，不盲目重试。
已开始的记录在进程重启后不自动标记成功或重跑，保留供宿主核对。
audit 的开始/结束写入不与任意业务包事务绑定。账号安全事件继续由 admin-auth 记录。

超时后尚未结束的业务保留 running 记录，最终 settle 后写入真实状态与 timeout/cancelled 等等待状态。
如果调用方已经离开而最终结算失败，总包记录仅含 executionId/code 的警告；需宿主检查未完成审计。
审计数据保留/清理由宿主负责，首版不额外提供审计管理接口。

## 配置

| 配置                    | 默认     | 说明                                                   |
| ----------------------- | -------- | ------------------------------------------------------ |
| sourceName              | main     | 审计使用的命名关系型实例                               |
| maxConcurrentExecutions | 16       | 含认证/前置检查的在途上限，busy 立即拒绝，没有等待队列 |
| defaultTimeoutMs        | 30000    | 默认调用等待期限                                       |
| maxTimeoutMs            | 300000   | 每项 timeoutMs 上限，default 不可超过它                |
| maxDataBytes            | 1048576  | 输入/普通输出 JSON 的 UTF-8 大小上限                   |
| maxDefinitionBytes      | 262144   | 每份 Schema 或 bindings 的大小上限                     |
| maxAuditBytes           | 4096     | 安全摘要大小上限                                       |
| now                     | 当前时间 | 测试时钟 `() => string`；耗时仍使用单调时钟            |

本包的并发/大小限制不代替 backend 的网络请求大小、来源限流和连接数限制。
同进程插件是可信代码；不通过本注册表的其他接口不会自动获得管理员保护。

## 示例与验证

```sh
npm run example -w toy-admin
npm test -w toy-admin
npm run typecheck -w toy-admin
npx eslint packages/admin/admin
npx prettier packages/admin/admin --check
# 使用根目录 .env 的 DATABASE_URL，仅操作隔离临时 schema
npm run test:live -w toy-admin
```

example 使用真实 AdminAuth 与内存关系型测试替身，演示注册、调用、拒绝只读角色、审计及提供方卸载，不打印 Token。
单元测试覆盖 Schema/角色/资源校验、定义快照、生命周期、代次保护、超时/容量、审计故障、opaque 交付和真实认证集成。
类型测试使用 tsc 验证泛型与只读上下文；test:live 使用独立 PostgreSQL schema，结束时仅清理本次创建的 schema。
