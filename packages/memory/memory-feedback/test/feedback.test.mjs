/* global structuredClone */
import assert from "node:assert/strict"
import test from "node:test"
import { Context, Service } from "cordis"
import { ToyStorage } from "toy-storage"
import { RelationalStorage } from "toy-storage-relational"
import { MemoryFeedback, MemoryFeedbackError, feedbackRelationalSchema } from "../lib/index.js"

/** 内存关系型 adapter：仅实现测试需要的 insert/get/find/update 与条件过滤。 */
class FakeRelational extends Service {
  static inject = ["storage"]

  constructor(ctx, config = {}) {
    super(ctx, "fakeRelational")
    this.schema = config.schema ?? feedbackRelationalSchema
    this.rows = new Map(Object.keys(this.schema.tables).map((name) => [name, new Map()]))
  }

  [Service.init]() {
    this.ctx.storage.register("relational", "main", this)
  }

  async execute(operation) {
    const table = this.rows.get(operation.table)
    const primary = this.schema.tables[operation.table].primaryKey
    if (operation.type === "insert") {
      const row = structuredClone(operation.value)
      if (table.has(row[primary])) {
        throw new Error("duplicate key")
      }
      table.set(row[primary], row)
      return { row: structuredClone(row) }
    }
    if (operation.type === "get") {
      return { row: structuredClone(table.get(operation.key)) }
    }
    if (operation.type === "update") {
      let affectedRows = 0
      for (const row of table.values()) {
        if (!matches(row, operation.where)) {
          continue
        }
        Object.assign(row, structuredClone(operation.patch))
        affectedRows += 1
      }
      return { affectedRows }
    }
    if (operation.type === "find") {
      const rows = [...table.values()].filter(
        (row) => !operation.where || matches(row, operation.where),
      )
      for (const order of [...(operation.orderBy ?? [])].reverse()) {
        rows.sort(
          (a, b) => compare(a[order.field], b[order.field]) * (order.direction === "desc" ? -1 : 1),
        )
      }
      const start = operation.offset ?? 0
      return { rows: structuredClone(rows.slice(start, start + (operation.limit ?? rows.length))) }
    }
    throw new Error(`fake 不支持 ${operation.type}`)
  }
}

function compare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0
}

function matches(row, filter) {
  switch (filter.type) {
    case "eq":
      return row[filter.field] === filter.value
    case "in":
      return filter.values.includes(row[filter.field])
    case "isNull":
      return row[filter.field] === null || row[filter.field] === undefined
    case "isNotNull":
      return row[filter.field] !== null && row[filter.field] !== undefined
    case "and":
      return filter.conditions.every((item) => matches(row, item))
    case "or":
      return filter.conditions.some((item) => matches(row, item))
    default:
      throw new Error(`fake 不支持 ${filter.type}`)
  }
}

async function setup(engine) {
  const ctx = new Context()
  const fibers = []
  fibers.push(await ctx.plugin(ToyStorage))
  fibers.push(await ctx.plugin(RelationalStorage))
  fibers.push(await ctx.plugin(FakeRelational))
  fibers.push(await ctx.plugin(MemoryFeedback))
  if (engine) {
    ctx.memoryFeedback.registerValueEngine(engine)
  }
  return {
    ctx,
    feedback: ctx.memoryFeedback,
    database: ctx.storage.get("relational", "main"),
    async dispose() {
      for (const fiber of fibers.reverse()) {
        await fiber.dispose()
      }
    },
  }
}

/** 假价值系统：记录每次 judgeSession 的输入，返回可预设的判断。 */
function fakeEngine(overrides = {}) {
  const calls = []
  const engine = {
    async judgeSession(input) {
      calls.push(input)
      const key = `${input.unitType}:${input.unitId}`
      const preset = overrides[key]
      if (preset) {
        return preset
      }
      return {
        feedbackType: "confirmed",
        evidenceTurnNos: input.relevantTurns
          .filter((turn) => turn.userText !== "")
          .map((turn) => turn.turnNo),
        judgementData: { score: 1 },
        judgementVersion: 1,
      }
    },
    settle() {
      throw new Error("settle 不应在 Session 收尾测试中被调用")
    },
    initialize() {
      throw new Error("initialize 不应在 Session 收尾测试中被调用")
    },
  }
  return { engine, calls }
}

function recallEntry(turnNo, turnId, units) {
  return { turnNo, turnId, units }
}

function unit(unitType, unitId, blockId, recalledContent) {
  return {
    unitType,
    unitId,
    blockId,
    recalledContent:
      recalledContent ??
      (unitType === "overview"
        ? { title: "猫", summary: "用户养猫", overviewBody: "用户养了一只猫。" }
        : { summary: "猫的名字", body: "用户的猫叫团子。" }),
  }
}

function turn(turnNo, userText, assistantText = "") {
  return { turnNo, userText, assistantText }
}

test("Session 收尾为每个召回价值单元生成一条反馈", async () => {
  const { engine, calls } = fakeEngine()
  const app = await setup(engine)
  try {
    const input = {
      userId: "u1",
      memorySpaceId: "m1",
      sessionId: "s1",
      recalls: [
        recallEntry(1, "t1", [unit("overview", "b1", "b1")]),
        recallEntry(3, "t3", [unit("detail", "d1", "b1"), unit("overview", "b1", "b1")]),
      ],
      conversation: [turn(1, "你好"), turn(2, "我喜欢猫"), turn(3, "再聊聊"), turn(4, "谢谢")],
    }
    const outcomes = await app.feedback.settleSessionFeedback(input)
    assert.equal(outcomes.length, 2)
    assert.equal(calls.length, 2)
    assert.equal(app.database.rows.get("toy_memory_feedback_entries").size, 2)
    const byType = new Set(outcomes.map((outcome) => outcome.unitType))
    assert.deepEqual(byType, new Set(["overview", "detail"]))
  } finally {
    await app.dispose()
  }
})

test("重复收尾幂等：已存在的单元不重复调用价值系统", async () => {
  const { engine, calls } = fakeEngine()
  const app = await setup(engine)
  try {
    const input = {
      userId: "u1",
      memorySpaceId: "m1",
      sessionId: "s1",
      recalls: [recallEntry(1, "t1", [unit("overview", "b1", "b1")])],
      conversation: [turn(1, "你好"), turn(2, "我喜欢猫")],
    }
    const first = await app.feedback.settleSessionFeedback(input)
    assert.equal(first.length, 1)
    assert.equal(calls.length, 1)
    const second = await app.feedback.settleSessionFeedback(input)
    assert.equal(second.length, 1)
    assert.equal(calls.length, 1)
    assert.equal(second[0].feedbackId, first[0].feedbackId)
  } finally {
    await app.dispose()
  }
})

test("影响区间只包含第一次召回之后的对话", async () => {
  const { engine, calls } = fakeEngine()
  const app = await setup(engine)
  try {
    const input = {
      userId: "u1",
      memorySpaceId: "m1",
      sessionId: "s1",
      recalls: [recallEntry(3, "t3", [unit("overview", "b1", "b1")])],
      conversation: [
        turn(1, "第一次"),
        turn(2, "第二次"),
        turn(3, "召回轮", "你养了一只猫。"),
        turn(4, "召回后一"),
        turn(5, "召回后二"),
      ],
    }
    await app.feedback.settleSessionFeedback(input)
    assert.equal(calls.length, 1)
    const received = calls[0]
    assert.deepEqual(received.recallTurnNos, [3])
    assert.deepEqual(received.recalledContent, input.recalls[0].units[0].recalledContent)
    assert.deepEqual(received.recallAssistantTurns, [
      { turnNo: 3, assistantText: "你养了一只猫。" },
    ])
    assert.deepEqual(
      received.relevantTurns.map((item) => item.turnNo),
      [4, 5],
    )
  } finally {
    await app.dispose()
  }
})

test("重复召回按轮次保留不同正文快照，首次正文不被后续内容覆盖", async () => {
  const { engine, calls } = fakeEngine()
  const app = await setup(engine)
  try {
    const original = unit("overview", "b1", "b1")
    const changed = unit("overview", "b1", "b1", {
      title: "猫",
      summary: "用户养两只猫",
      overviewBody: "用户养了两只猫。",
    })
    await app.feedback.settleSessionFeedback({
      userId: "u1",
      memorySpaceId: "m1",
      sessionId: "s1",
      recalls: [recallEntry(3, "t3", [changed]), recallEntry(1, "t1", [original])],
      conversation: [turn(1, "你好", "你养了一只猫。"), turn(2, "现在有两只了"), turn(3, "再聊聊")],
    })
    assert.equal(calls.length, 1)
    assert.deepEqual(calls[0].recallTurnNos, [1, 3])
    assert.deepEqual(calls[0].recalledContent, original.recalledContent)
    assert.deepEqual(calls[0].recallSnapshots, [
      { ...original, turnNo: 1, turnId: "t1" },
      { ...changed, turnNo: 3, turnId: "t3" },
    ])
  } finally {
    await app.dispose()
  }
})

test("旧 ID-only 召回记录拒绝进入价值判断", async () => {
  const { engine, calls } = fakeEngine()
  const app = await setup(engine)
  try {
    await assert.rejects(
      () =>
        app.feedback.settleSessionFeedback({
          userId: "u1",
          memorySpaceId: "m1",
          sessionId: "s1",
          recalls: [recallEntry(1, "t1", [{ unitType: "overview", unitId: "b1", blockId: "b1" }])],
          conversation: [turn(1, "你好"), turn(2, "对")],
        }),
      (error) => error instanceof MemoryFeedbackError && error.code === "invalid-input",
    )
    assert.equal(calls.length, 0)
  } finally {
    await app.dispose()
  }
})

test("listPending 与 markConsolidated 协同工作", async () => {
  const { engine } = fakeEngine()
  const app = await setup(engine)
  try {
    const input = {
      userId: "u1",
      memorySpaceId: "m1",
      sessionId: "s1",
      recalls: [recallEntry(1, "t1", [unit("overview", "b1", "b1"), unit("detail", "d1", "b1")])],
      conversation: [turn(1, "你好"), turn(2, "我喜欢猫")],
    }
    const outcomes = await app.feedback.settleSessionFeedback(input)
    assert.equal(outcomes.length, 2)
    const pending = await app.feedback.listPending({ userId: "u1", memorySpaceId: "m1" })
    assert.equal(pending.length, 2)

    await app.feedback.markConsolidated({ userId: "u1", memorySpaceId: "m1" }, "batch-1", [
      outcomes[0].feedbackId,
    ])
    const after = await app.feedback.listPending({ userId: "u1", memorySpaceId: "m1" })
    assert.equal(after.length, 1)
    assert.equal(after[0].feedbackId, outcomes[1].feedbackId)
  } finally {
    await app.dispose()
  }
})

test("markConsolidated 拒绝不存在或不属于该空间的反馈", async () => {
  const { engine } = fakeEngine()
  const app = await setup(engine)
  try {
    await app.feedback.settleSessionFeedback({
      userId: "u1",
      memorySpaceId: "m1",
      sessionId: "s1",
      recalls: [recallEntry(1, "t1", [unit("overview", "b1", "b1")])],
      conversation: [turn(1, "你好")],
    })
    await assert.rejects(
      () =>
        app.feedback.markConsolidated({ userId: "u1", memorySpaceId: "m1" }, "batch-1", [
          "missing",
        ]),
      (error) => error instanceof MemoryFeedbackError && error.code === "invalid-state",
    )
  } finally {
    await app.dispose()
  }
})

test("未注册价值系统时收尾抛错，重复注册抛错", async () => {
  const noEngine = await setup()
  try {
    await assert.rejects(
      () =>
        noEngine.feedback.settleSessionFeedback({
          userId: "u1",
          memorySpaceId: "m1",
          sessionId: "s1",
          recalls: [],
          conversation: [],
        }),
      (error) => error instanceof MemoryFeedbackError && error.code === "engine-not-registered",
    )
  } finally {
    await noEngine.dispose()
  }

  const { engine } = fakeEngine()
  const app = await setup(engine)
  try {
    assert.throws(
      () => app.feedback.registerValueEngine(fakeEngine().engine),
      (error) => error instanceof MemoryFeedbackError && error.code === "engine-already-registered",
    )
  } finally {
    await app.dispose()
  }
})
