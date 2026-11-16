/* global setTimeout */
import assert from "node:assert/strict"
import test from "node:test"
import { Context, Service } from "cordis"
import { ToyStorage } from "toy-storage"
import { StorageWriteQueue, WriteQueueError } from "../lib/index.js"

class FakeStore extends Service {
  static inject = ["storage"]

  constructor(ctx, config) {
    super(ctx, `fakeStore.${config.name}`)
    this.name = config.name
    this.storageKind = config.kind ?? "fake"
    this.executeOperation = config.execute
  }

  async [Service.init]() {
    this.ctx.storage.register(this.storageKind, this.name, this)
  }

  execute(operation) {
    return this.executeOperation(operation)
  }
}

async function setup(execute, config = {}) {
  const root = new Context()
  const storageFiber = await root.plugin(ToyStorage)
  const queueFiber = await root.plugin(StorageWriteQueue, config)
  const fakeFiber = await root.plugin(FakeStore, { name: "main", execute })
  return {
    root,
    queue: root.storageWriteQueue,
    async dispose() {
      await queueFiber.dispose()
      await fakeFiber.dispose()
      await storageFiber.dispose()
    },
  }
}

function job(jobId, queueName = "events", operation = { value: jobId }) {
  return { jobId, queueName, target: { kind: "fake", name: "main" }, operation }
}

function deferred() {
  let resolve
  let reject
  const promise = new Promise((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

async function nextTick() {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

test("成功提交前保留任务，成功后出队并保留凭据状态", async () => {
  const gate = deferred()
  let received
  const app = await setup(async (operation) => {
    received = operation
    await gate.promise
  })
  try {
    const operation = { value: { text: "original" } }
    const receipt = app.queue.enqueue(job("e1", "events", operation))
    operation.value.text = "changed"
    await nextTick()
    assert.equal(app.queue.getStatus(receipt), "writing")
    assert.equal(app.queue.getStats("events").pending, 1)
    assert.deepEqual(received, { value: { text: "original" } })
    gate.resolve()
    await app.queue.waitFor(receipt)
    assert.equal(app.queue.getStatus(receipt), "committed")
    assert.equal(app.queue.getStats("events").pending, 0)
    await app.queue.waitFor(receipt)
  } finally {
    await app.dispose()
  }
})

test("同一逻辑队列严格保序，enqueueMany 校验失败时整批不入队", async () => {
  const order = []
  const app = await setup(async (operation) => {
    order.push(operation.value)
  })
  try {
    assert.throws(
      () => app.queue.enqueueMany([job("e1"), job("e1")]),
      (error) => error instanceof WriteQueueError && error.code === "duplicate-job",
    )
    assert.equal(app.queue.getStats().pending, 0)
    const receipts = app.queue.enqueueMany([job("e1"), job("e2"), job("e3")])
    await Promise.all(receipts.map((receipt) => app.queue.waitFor(receipt)))
    assert.deepEqual(order, ["e1", "e2", "e3"])
  } finally {
    await app.dispose()
  }
})

test("不同队列共用目标写入并发额度，不会同时占满连接", async () => {
  const first = deferred()
  const second = deferred()
  const started = []
  const app = await setup(async (operation) => {
    started.push(operation.value)
    await (operation.value === "e1" ? first.promise : second.promise)
  })
  try {
    const one = app.queue.enqueue(job("e1", "events"))
    const two = app.queue.enqueue(job("e2", "profiles"))
    await nextTick()
    assert.deepEqual(started, ["e1"])
    first.resolve()
    await app.queue.waitFor(one)
    await nextTick()
    assert.deepEqual(started, ["e1", "e2"])
    second.resolve()
    await app.queue.waitFor(two)
  } finally {
    await app.dispose()
  }
})

test("不同存储类型的目标可以并行执行各自的操作", async () => {
  const root = new Context()
  const storage = await root.plugin(ToyStorage)
  const queue = await root.plugin(StorageWriteQueue)
  const relationalGate = deferred()
  const vectorGate = deferred()
  const started = []
  const relational = await root.plugin(FakeStore, {
    kind: "relational",
    name: "main",
    execute: async (operation) => {
      started.push(operation.type)
      await relationalGate.promise
    },
  })
  const vector = await root.plugin(FakeStore, {
    kind: "vector",
    name: "primary",
    execute: async (operation) => {
      started.push(operation.type)
      await vectorGate.promise
    },
  })
  try {
    const one = root.storageWriteQueue.enqueue({
      jobId: "row:1",
      queueName: "rows",
      target: { kind: "relational", name: "main" },
      operation: { type: "insert", table: "rows", value: { id: "1" } },
    })
    const two = root.storageWriteQueue.enqueue({
      jobId: "embedding:1",
      queueName: "embeddings",
      target: { kind: "vector", name: "primary" },
      operation: { type: "upsertVector", id: "1", vector: [0.1, 0.2] },
    })
    await nextTick()
    assert.deepEqual(started, ["insert", "upsertVector"])
    relationalGate.resolve()
    vectorGate.resolve()
    await Promise.all([root.storageWriteQueue.waitFor(one), root.storageWriteQueue.waitFor(two)])
  } finally {
    await queue.dispose()
    await vector.dispose()
    await relational.dispose()
    await storage.dispose()
  }
})

test("明确可重试的失败保留任务并退避，等待超时不取消写入", async () => {
  let attempts = 0
  const app = await setup(
    async () => {
      attempts++
      if (attempts === 1) {
        throw Object.assign(new Error("temporary"), { retryable: true })
      }
    },
    { retryBaseMs: 30, retryMaxMs: 30 },
  )
  try {
    const receipt = app.queue.enqueue(job("e1"))
    await assert.rejects(
      () => app.queue.waitFor(receipt, { timeoutMs: 5 }),
      (error) => error instanceof WriteQueueError && error.code === "wait-timeout",
    )
    assert.equal(app.queue.getStats().pending, 1)
    await app.queue.waitFor(receipt)
    assert.equal(attempts, 2)
    assert.equal(app.queue.getStatus(receipt), "committed")
  } finally {
    await app.dispose()
  }
})

test("提交结果不明时阻塞而不重试，后续同队列任务不能越过", async () => {
  let attempts = 0
  const app = await setup(async () => {
    attempts++
    throw Object.assign(new Error("commit uncertain"), { retryable: true, unknownState: true })
  })
  try {
    const first = app.queue.enqueue(job("e1"))
    const second = app.queue.enqueue(job("e2"))
    await assert.rejects(
      () => app.queue.waitFor(first),
      (error) => error instanceof WriteQueueError && error.code === "job-blocked",
    )
    await nextTick()
    assert.equal(attempts, 1)
    assert.equal(app.queue.getStatus(first), "blocked")
    assert.equal(app.queue.getStatus(second), "queued")
    assert.equal(app.queue.getStats().pending, 2)
    await assert.rejects(() => app.queue.flush({ queueName: "events" }), /写入受阻/)
  } finally {
    await app.dispose()
  }
})

test("修复错误后可手动重试 blocked 任务，且不会删除后续任务", async () => {
  let repaired = false
  const order = []
  const app = await setup(async (operation) => {
    if (!repaired) {
      throw new Error("schema mismatch")
    }
    order.push(operation.value)
  })
  try {
    const first = app.queue.enqueue(job("e1"))
    const second = app.queue.enqueue(job("e2"))
    await assert.rejects(() => app.queue.waitFor(first), /写入受阻/)
    assert.equal(app.queue.getStatus(second), "queued")
    repaired = true
    app.queue.retryBlocked(first)
    await Promise.all([app.queue.waitFor(first), app.queue.waitFor(second)])
    assert.deepEqual(order, ["e1", "e2"])
    assert.equal(app.queue.getStats().pending, 0)
  } finally {
    await app.dispose()
  }
})

test("flush 只等待调用时已有任务，目标不存在时拒绝入队", async () => {
  const first = deferred()
  const second = deferred()
  const app = await setup(async (operation) => {
    await (operation.value === "e1" ? first.promise : second.promise)
  })
  try {
    assert.throws(
      () =>
        app.queue.enqueue({
          ...job("missing"),
          target: { kind: "fake", name: "missing" },
        }),
      (error) => error instanceof WriteQueueError && error.code === "target-unavailable",
    )
    const one = app.queue.enqueue(job("e1"))
    const flushed = app.queue.flush({ queueName: "events" })
    const two = app.queue.enqueue(job("e2"))
    first.resolve()
    await flushed
    assert.equal(app.queue.getStatus(one), "committed")
    assert.notEqual(app.queue.getStatus(two), "committed")
    second.resolve()
    await app.queue.waitFor(two)
  } finally {
    await app.dispose()
  }
})
