# toy-session-data

基于 Cordis 的 Session 数据插件。挂载后通过 `ctx.sessionData.agent` 操作 Agent 运行数据，通过 `ctx.sessionData.read` 读取端侧展示数据。两个对象都是类实例，方法由同一个插件提供。调用方不需要接触数据库 adapter、写入队列或内部 Map。

## 模式与两份内存

插件初始化时查找已经挂载的 `ctx.sessionStorage`。找到则固定为 `persistent`，否则固定为 `memory`；`getMode()` 可读取当前模式。

- Agent 运行存储按 `sessionId` 保存 active 和 closing Session 的全部 Turn/Event。每个 Turn 包含自己的 `events` 数组，另用 `turnId` 索引指向同一个 Turn 对象。关闭后移除 Agent 运行数据。
- 端侧读取存储独立保存 Session、Turn/Event。无数据库时保存全部历史，包括已关闭的 Session；有数据库时保留活跃数据和最近访问的历史，缓存未命中时通过 `toy-session-storage` 补读。
- Event 在两个存储中使用相同的 `eventId`、`sequence` 和不可变记录；两个存储各有自己的 Turn/Event 数组。数据库确认落库不会立即清除可读缓存。
- 数据库模式下，Session 和 Turn 创建经数据库确认后返回；Event 先被写入队列接受，再更新两份可读内存。`finishClosingSession` 等待该 Session 的队列写完才写入最终 Session payload 并移除 Agent 运行数据。

## 数据变化通知

插件在成功更新两份内存后发布 Cordis 事件 `session-data/change`。监听器收到只读快照，抛错或异步失败只会记日志，不会改变写入结果。单次 `appendEvents` 只发一条包含全部 Event 的通知。

```js
const unlisten = ctx.on("session-data/change", (change) => {
  if (change.kind === "events-appended") {
    // change.sessionId、change.turnId、change.events；Event 已可读，但可能仍在写入队列。
    console.log(change.events.map((event) => event.eventId))
  }
})

// 不再需要监听时：unlisten()
```

| `kind`            | 通知内容        | 发出时点                                     |
| ----------------- | --------------- | -------------------------------------------- |
| `session-created` | 完整 Session    | 创建完成，两份内存更新后                     |
| `turn-created`    | 完整 Turn       | 创建完成，两份内存更新后                     |
| `events-appended` | 本批全部 Event  | 写入队列接受且两份内存更新后；不代表已经落库 |
| `session-closing` | closing Session | 状态更新后                                   |
| `session-closed`  | closed Session  | 待写 Event 落库、状态更新且 Agent 历史释放后 |

通知只在当前进程内分发，不提供重放；前端重连应调用读取接口补齐历史。读取、缓存淘汰、`waitForWrites` 和 `restoreSession` 不发数据变化通知。事件类型 `SessionDataChange` 从包入口导出，供监听插件使用。

## Agent 接口

| 方法                                                          | 作用                                                          |
| ------------------------------------------------------------- | ------------------------------------------------------------- |
| `createSession(input)`                                        | 创建 active Session；数据库模式同步落库                       |
| `createTurn(sessionId)`                                       | 创建 Turn；数据库模式同步落库                                 |
| `appendEvents(sessionId, turnId, inputs)`                     | 分配 Event ID/sequence，入队并更新两份内存                    |
| `beginClosingSession(sessionId)`                              | 记录 closing，同设备可创建新 Session                          |
| `finishClosingSession(sessionId, input, options?)`            | 保存最终 Session 数据并释放 Agent 运行历史                    |
| `waitForWrites(sessionId, options?)`                          | 等待该 Session 已入队 Event 落库；内存模式立即完成            |
| `getSession(sessionId)`、`getActiveSession(userId, deviceId)` | 只查询 Agent 驻留内存                                         |
| `getHistory(sessionId)`、`getTurn(sessionId, turnId)`         | 读取完整驻留历史或一个完整 Turn                               |
| `getTurnEvents(sessionId, turnId)`                            | 按一个 Turn ID 读取 Event                                     |
| `getTurnsEvents(sessionId, turnIds)`                          | 按多个 Turn ID 读取完整 Event，按 turnNo 升序                 |
| `getPreviousTurnEvents(sessionId, beforeTurnId, count)`       | 读取指定 Turn 之前最近几个完整 Turn/Event                     |
| `restoreSession(sessionId)`                                   | 数据库模式下显式恢复 active/closing Session 的完整 Agent 历史 |

Agent 的普通读取不会隐式访问数据库；Session 不在运行内存时抛出 `not-resident`，不能误当成空历史。

## 端侧读取接口

| 方法                                                          | 作用                                    |
| ------------------------------------------------------------- | --------------------------------------- |
| `getSession(sessionId)`、`getActiveSession(userId, deviceId)` | 读取 Session 元数据                     |
| `listSessions({ userId, deviceId, before?, limit? })`         | 按用户设备分页列出 Session              |
| `getTurnHistory(sessionId, turnId)`                           | 精确读取一个 Turn 的全部 Event          |
| `getTurnsHistory(sessionId, turnIds)`                         | 精确读取多个 Turn 的全部 Event          |
| `listTurnHistory({ sessionId, beforeTurnNo?, limit? })`       | 按 Turn 分页，每个 Turn 的 Event 不截断 |

端侧对象只提供读取；创建和追加只通过 `agent` 方法进行，内部同步到两份内存。

## 挂载示例

```js
import { Context } from "cordis"
import { SessionData } from "toy-session-data"

const ctx = new Context()
await ctx.plugin(SessionData) // 无数据库：全部历史留在端侧读取存储

const session = await ctx.sessionData.agent.createSession({ userId: "u1", deviceId: "d1" })
const turn = await ctx.sessionData.agent.createTurn(session.sessionId)
await ctx.sessionData.agent.appendEvents(session.sessionId, turn.turnId, [
  { eventType: "user_message", payload: { text: "你好" } },
])
const events = ctx.sessionData.agent.getTurnEvents(session.sessionId, turn.turnId)
const page = await ctx.sessionData.read.listTurnHistory({ sessionId: session.sessionId, limit: 10 })
```

数据库模式先挂载 `toy-storage`、`toy-storage-relational`、`toy-storage-write-queue`、数据库 adapter 和 `toy-session-storage`，最后挂载本插件。`toy-session-storage` 的 README 有数据库注册示例。

## 可运行示例与测试

在项目根目录执行：

```powershell
npm run example:memory -w toy-session-data
npm test -w toy-session-data
```

纯内存示例位于 `examples/memory.mjs`，展示创建 Session/Turn、追加 Event、按 Turn 读取以及关闭后从端侧读取历史。测试同时覆盖两份内存同步和纯内存模式不淘汰已关闭历史。

PostgreSQL 示例需要先在项目根目录的 `.env` 中设置 `DATABASE_URL`，然后执行：

```powershell
npm run example:postgres -w toy-session-data
npm run test:live -w toy-session-data
```

`examples/postgres.mjs` 展示完整插件挂载顺序。它在 `appendEvents` 后读取内存，在 `waitForWrites` 后用独立 PostgreSQL 连接查询实际 Event 行数，避免把缓存可读误认为已落库。示例数据留在 `toy_session_data_example` Schema 中，运行结果会输出 Session ID 以便检查。实库测试使用临时 Schema，并在结束时清理。普通测试还用可暂停的关系型存储验证：写入暂停期间两份内存仍可读，`waitForWrites` 和 `finishClosingSession` 都会等待写入完成。

## 当前边界

- 纯内存模式重启后丢失全部数据；数据库模式的写入队列也只在进程内，意外退出可能丢失尚未落库的 Event。
- Agent 恢复是显式方法。恢复时读取该 Session 的全部已落库 Turn/Event；未落库且随进程退出丢失的 Event 无法恢复。
- `maxReadSessions` 和 `maxReadPages` 是数据库模式的软上限；active/closing Session 不淘汰，内存模式全部历史不淘汰。
