/* global console, structuredClone */
import { Context, Service } from "cordis"
import { ToyStorage } from "toy-storage"
import { RelationalStorage } from "toy-storage-relational"
import { MemoryFeedback, feedbackRelationalSchema } from "../lib/index.js"

/** 内存关系型 adapter：example 无需数据库即可演示完整流程。 */
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
      table.set(row[primary], row)
      return { row: structuredClone(row) }
    }
    if (operation.type === "update") {
      let affectedRows = 0
      for (const row of table.values()) {
        if (matches(row, operation.where)) {
          Object.assign(row, structuredClone(operation.patch))
          affectedRows += 1
        }
      }
      return { affectedRows }
    }
    if (operation.type === "find") {
      const rows = [...table.values()].filter(
        (row) => !operation.where || matches(row, operation.where),
      )
      return { rows: structuredClone(rows) }
    }
    throw new Error(`fake 不支持 ${operation.type}`)
  }
}

function matches(row, filter) {
  switch (filter.type) {
    case "eq":
      return row[filter.field] === filter.value
    case "in":
      return filter.values.includes(row[filter.field])
    case "isNull":
      return row[filter.field] === null || row[filter.field] === undefined
    case "and":
      return filter.conditions.every((item) => matches(row, item))
    default:
      throw new Error(`fake 不支持 ${filter.type}`)
  }
}

/** 示例价值系统：简单的态度判断，确认则给正信号。 */
const exampleEngine = {
  async judgeSession(input) {
    const evidence = input.relevantTurns
      .filter((turn) => turn.userText !== "")
      .map((turn) => turn.turnNo)
    return {
      feedbackType: evidence.length > 0 ? "confirmed" : "no_user_signal",
      evidenceTurnNos: evidence,
      judgementData: { score: evidence.length },
      judgementVersion: 1,
    }
  },
  settle({ state }) {
    return state
  },
  initialize() {
    return {
      value: 1,
      belowThresholdCycles: 0,
      lifecycle: "active",
      valueData: {},
      valueVersion: 1,
    }
  },
}

const ctx = new Context()
const fibers = []
try {
  fibers.push(await ctx.plugin(ToyStorage))
  fibers.push(await ctx.plugin(RelationalStorage))
  fibers.push(await ctx.plugin(FakeRelational))
  fibers.push(await ctx.plugin(MemoryFeedback))
  ctx.memoryFeedback.registerValueEngine(exampleEngine)

  // 模拟一个 Session：turn 1 召回了块 b1 的概括，turn 3 召回了细节 d1。
  const outcomes = await ctx.memoryFeedback.settleSessionFeedback({
    userId: "u1",
    memorySpaceId: "m1",
    sessionId: "s1",
    recalls: [
      {
        turnNo: 1,
        turnId: "t1",
        units: [
          {
            unitType: "overview",
            unitId: "b1",
            blockId: "b1",
            recalledContent: { title: "猫", summary: "用户养猫", overviewBody: "用户养了一只猫。" },
          },
        ],
      },
      {
        turnNo: 3,
        turnId: "t3",
        units: [
          {
            unitType: "detail",
            unitId: "d1",
            blockId: "b1",
            recalledContent: { summary: "猫的名字", body: "用户的猫叫团子。" },
          },
        ],
      },
    ],
    conversation: [
      { turnNo: 1, userText: "你好", assistantText: "你好！" },
      { turnNo: 2, userText: "我喜欢猫", assistantText: "好的，记下了" },
      { turnNo: 3, userText: "再聊聊我的猫", assistantText: "你的猫叫团子" },
      { turnNo: 4, userText: "对，就是它", assistantText: "明白了" },
    ],
  })
  console.log("收尾生成的反馈：", outcomes)

  const pending = await ctx.memoryFeedback.listPending({ userId: "u1", memorySpaceId: "m1" })
  console.log(
    "待 Daily 巩固：",
    pending.map((item) => item.feedbackId),
  )

  await ctx.memoryFeedback.markConsolidated(
    { userId: "u1", memorySpaceId: "m1" },
    "daily-batch-1",
    outcomes.map((item) => item.feedbackId),
  )
  console.log(
    "巩固后剩余：",
    await ctx.memoryFeedback.listPending({ userId: "u1", memorySpaceId: "m1" }),
  )
} finally {
  for (const fiber of fibers.reverse()) {
    await fiber.dispose()
  }
}
