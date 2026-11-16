# toy-session-storage

Session、Turn、Event 的关系型表定义与操作封装，作为 Cordis 类插件挂载到 `ctx.sessionStorage`。本包不保存 Agent 运行历史，也不实现读取缓存或纯内存数据库。

## 职责

- 导出 `sessionRelationalSchema`，定义 `toy_sessions`、`toy_session_turns`、`toy_session_events` 的字段与索引。
- 通过名称调用已经连接的关系型 adapter。Session、Turn 创建和 Session 状态更新同步落库。
- 把上层传入的完整 Event 转换为关系型 `insert`，提交给现有写入队列；返回值是写入凭据，不表示已落库。
- 从关系型 adapter 读取 Session 列表和按 Turn 分页的完整 Event 历史。

运行缓存与读取缓存由后续独立的内存插件负责；它们可以直接使用本包暴露的方法。没有数据库时不挂载本插件，由内存插件提供数据服务。

## 注册

```js
import { Context } from "cordis"
import { ToyStorage } from "toy-storage"
import { RelationalStorage } from "toy-storage-relational"
import { PostgresStorage } from "toy-storage-postgres"
import { StorageWriteQueue } from "toy-storage-write-queue"
import { SessionStorage, sessionRelationalSchema } from "toy-session-storage"

const ctx = new Context()
await ctx.plugin(ToyStorage)
await ctx.plugin(RelationalStorage)
await ctx.plugin(StorageWriteQueue)
await ctx.plugin(PostgresStorage, {
  name: "main",
  connectionString: process.env.DATABASE_URL,
  createMissing: true,
  schema: sessionRelationalSchema,
})
await ctx.plugin(SessionStorage, { sourceName: "main" })

const session = await ctx.sessionStorage.createSession({ userId: "u1", deviceId: "d1" })
const turn = await ctx.sessionStorage.createTurn(session.sessionId)
const event = {
  eventId: "e1", // 实际项目中使用稳定且唯一的 ID
  sessionId: session.sessionId,
  turnId: turn.turnId,
  sequence: 1, // 由上层 Session 运行存储分配
  eventType: "user_message",
  payload: { text: "你好" },
  version: 1,
  occurredAt: new Date().toISOString(),
}
const [receipt] = await ctx.sessionStorage.appendEvents(session.sessionId, turn.turnId, [event])
await ctx.storageWriteQueue.waitFor(receipt)
const history = await ctx.sessionStorage.listTurnHistory({
  sessionId: session.sessionId,
  limit: 10,
})
await ctx.sessionStorage.beginClosingSession(session.sessionId)
await ctx.sessionStorage.finishClosingSession(session.sessionId, {
  payload: { summary: "本次对话结束" },
  version: 1,
})
```

完整可运行示例位于 `examples/basic.mjs`。当数据库还包含其他业务表时，宿主需要先把各包导出的 `schema.tables` 合并，再传给 PostgreSQL 插件。`createMissing` 只创建缺失的表和索引，不迁移已有表。

## 方法

| 方法                                | 行为                                                              |
| ----------------------------------- | ----------------------------------------------------------------- |
| `createSession`                     | 同步插入 active Session，数据库确认后返回 ID                      |
| `createTurn`                        | 读取当前最新 `turnNo`，同步插入下一个 Turn                        |
| `appendEvents`                      | 验证完整 Event 与 Turn 归属，逐条加入写入队列                     |
| `beginClosingSession`               | 同步更新为 closing，同设备随后可创建新 Session                    |
| `finishClosingSession`              | 等待该 Session 队列写完，保存最终 payload/version 并更新为 closed |
| `getSession`、`getActiveSession`    | 从数据库读取 Session                                              |
| `listSessions`                      | 按用户设备及创建时间游标分页                                      |
| `listTurnHistory`                   | 按 Turn 分页，每个 Turn 读取全部已落库 Event                      |
| `getTurnHistory`、`getTurnsHistory` | 按一个或多个 Turn ID 精确读取全部已落库 Event                     |
| `waitForSessionWrites`              | 等待该 Session 当前队列中的任务                                   |

`listTurnHistory` 只读取已经落库的 Event。上层若要展示尚未落库的 Event，应由自己的内存读取服务合并；本包不会复制那份内存数据。

## 当前边界

- `sequence` 由调用方分配，本包不保存 Session 内的 sequence 计数。`eventId` 也由调用方提供，便于内存与数据库使用同一个标识。
- 同一用户设备最多一个 active Session 目前由本插件查询后检查；跨进程严格保证仍需数据库约束。当前关系型 Schema 协议没有部分唯一索引和外键。
- `createTurn` 的 `turnNo` 在单个插件实例内串行分配；多个进程同时操作同一 Session 时，数据库唯一索引会阻止重复值，但冲突调用需要上层重试。
- 写入队列在进程内；进程意外退出时，尚未落库的 Event 会丢失。`version` 是 payload 格式版本，不是并发修订号。
