# toy-storage-write-queue

通用的内存写入队列 Cordis 类插件，服务名为 `ctx.storageWriteQueue`。
队列只通过 `ctx.storage` 按 `kind + name` 找到已就绪实例，调用该实例现有的
`execute(operation)`；关系型、未来的向量型操作由各自的存储实例解释。

## 用法

先加载 `toy-storage`、目标数据库插件和本插件。目标数据库在 `ctx.storage` 中注册后，
业务插件将已转换好的写操作入队：

```ts
const receipt = ctx.storageWriteQueue.enqueue({
  jobId: `event:${eventId}`,
  queueName: "session-events",
  target: { kind: "relational", name: "main" },
  operation: {
    type: "insert",
    table: "events",
    value: eventRow,
  },
})

// 入队后即可从本进程内存读取 Event；需要确认落库时再等待这张凭据。
await ctx.storageWriteQueue.waitFor(receipt)
console.log(ctx.storageWriteQueue.getStatus(receipt)) // committed
```

`enqueueMany(jobs)` 在完整校验后一次性接收一组任务。`flush({ queueName })` 等待
调用瞬间已经在该队列中的任务；`getStats(queueName?)` 返回待写数量和状态统计。
`getStatus(receipt)` 可在任务出队后继续查询结果，凭据仅对创建它的队列实例有效。

同一 `queueName` 中严格按入队顺序写入；不同队列可并行，但同一目标的写入总并发
由 `maxConcurrentPerTarget` 控制，默认 1。目标不存在时拒绝入队；入队后目标暂时失联，
任务会保留并延迟重试。只有目标 `execute` 成功返回才移除任务。

自动重试仅用于错误明确提供 `retryable: true` 且未标记 `unknownState: true` 的情况。
永久错误和未知提交状态保留为 `blocked`，后续同队列任务不会越过。`waitFor` 超时
只停止本次等待，不删除任务。队列不解析操作内容，调用方必须只提交写操作并为
需要重试的数据使用稳定 ID。成功任务的操作内容会释放，队列不会永久保存已完成的
`jobId`；同一任务日后再次入队仍会执行，因此目标存储也应以记录主键等机制保证幂等。
修复永久错误后可调用 `retryBlocked(receipt)`；若先前是未知提交状态，应先核对数据库，
再决定是否重试。

队列只保存在进程内存中，进程意外退出会丢失未落库任务。数据库长时间不可用时
待写数据会持续增长；第一版通过 `getStats()` 观察，不会静默丢弃已有任务。

从仓库根目录运行 PostgreSQL 实库验证：

```sh
npm run test:live -w toy-storage-write-queue
```
