# packages/session

Session 业务相关包的分组目录。

- `toy-session-storage`：定义 Session、Turn、Event 的关系型表，并封装数据库读写与 Event 入队；不保存内存历史。底层通过 `packages/storage` 中的通用插件访问命名数据库和写入队列。
- `toy-session-data`：通过 `ctx.sessionData.agent` 和 `ctx.sessionData.read` 提供 Session 数据操作；内部维护 Agent 运行存储和端侧读取存储，无数据库时保留全部历史。
- [`toy-session`](./session/README.md) 通过 `ctx.session` 编排创建、预处理、Turn 和后台关闭，使用 `toy-lifecycle` 运行前处理和后处理。
