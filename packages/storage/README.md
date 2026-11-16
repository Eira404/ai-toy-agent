# packages/storage

存储相关包的分组目录。

当前包含以下 Cordis 类插件。

- `toy-storage`：通过 `ctx.storage` 管理任意类型的命名存储实例。
- `toy-storage-relational`：通过 `ctx.storageRelational` 提供关系型 Schema、操作校验与特征分析；同时导出关系型 adapter 契约。
- `toy-storage-vector`：通过 `ctx.storageVector` 提供向量集合 Schema 与操作校验，同时导出向量 adapter 契约。用法见 [向量存储协议](storage-vector/README.md)。
- `toy-storage-pgvector`：基于 PostgreSQL 的 vector 扩展执行向量读写和相似度检索，以 `vector + name` 注册实例。用法见 [pgvector 存储插件](storage-pgvector/README.md)。
- `toy-storage-postgres`：连接 PostgreSQL、执行关系型操作与事务，并向 `ctx.storage` 注册命名实例。
- `toy-storage-write-queue`：通过 `ctx.storageWriteQueue` 将已构造的写操作按命名队列调度到对应存储实例。

具体数据库插件负责自己的连接、SQL 与释放。
