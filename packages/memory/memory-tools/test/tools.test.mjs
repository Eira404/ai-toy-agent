import assert from "node:assert/strict"
import test from "node:test"
import { Context, Service } from "cordis"
import { ToolRegistry } from "toy-tools"
import { ToyStorage } from "toy-storage"
import { RelationalStorage } from "toy-storage-relational"
import { MemoryFeedback, feedbackRelationalSchema } from "toy-memory-feedback"
import { MemoryTools, collectRecallUnits, formatReadResult, isGateExplicit } from "../lib/index.js"

class FakeMemorySpace extends Service {
  constructor(ctx) {
    super(ctx, "memorySpace")
  }

  async resolveMemorySpace(_userId, deviceId) {
    return deviceId === "d1" ? "space1" : null
  }
}

class FakeMemoryRead extends Service {
  constructor(ctx) {
    super(ctx, "memoryRead")
    this.last = null
  }

  async search(input) {
    this.last = input
    return {
      status: "COMPLETE",
      fast: {
        titleSucceeded: true,
        vectorSucceeded: true,
        hits: [
          {
            record: { title: "苹果", summary: "s", body: "b" },
            matchedBy: ["TITLE"],
            vectorScore: null,
          },
        ],
      },
      long: {
        status: "COMPLETE",
        blocks: [
          {
            blockId: "b1",
            domain: "person",
            title: "小明",
            aliases: [],
            summary: "s",
            overviewBody: "o",
            reason: "TITLE_MATCH",
            score: null,
            details: [{ detailId: "d1", summary: "ds", body: "db", score: 0.9 }],
          },
        ],
      },
    }
  }
}

class FakeMemoryWrite extends Service {
  constructor(ctx) {
    super(ctx, "memoryWrite")
    this.last = null
  }

  async write(input) {
    this.last = input
    return { kind: "written", writeId: "w1", records: [{}, {}] }
  }
}

/** 集成测试只需要反馈查询和插入；正文来自工具事件，存储不提供 Long 查询。 */
class FeedbackStore extends Service {
  static inject = ["storage"]

  constructor(ctx) {
    super(ctx, "feedbackStore")
    this.schema = feedbackRelationalSchema
    this.rows = []
  }

  [Service.init]() {
    this.ctx.storage.register("relational", "main", this)
  }

  async execute(operation) {
    if (operation.type === "find") {
      return {
        rows: this.rows.filter((row) =>
          operation.where.conditions.every((condition) => row[condition.field] === condition.value),
        ),
      }
    }
    if (operation.type === "insert") {
      this.rows.push(operation.value)
      return { row: operation.value }
    }
    throw new Error(`不支持 ${operation.type}`)
  }
}

async function setup(payload = {}, engine) {
  const ctx = new Context()
  const fibers = []
  fibers.push(await ctx.plugin(ToolRegistry))
  fibers.push(await ctx.plugin(FakeMemorySpace))
  fibers.push(await ctx.plugin(FakeMemoryRead))
  fibers.push(await ctx.plugin(FakeMemoryWrite))
  fibers.push(await ctx.plugin(MemoryTools))
  if (engine) {
    fibers.push(await ctx.plugin(ToyStorage))
    fibers.push(await ctx.plugin(RelationalStorage))
    fibers.push(await ctx.plugin(FeedbackStore))
    fibers.push(await ctx.plugin(MemoryFeedback))
    ctx.memoryFeedback.registerValueEngine(engine)
  }
  return {
    ctx,
    toolSet: ctx.tools.resolve({
      scope: { userId: "u1", deviceId: "d1", sessionId: "s1", turnId: "t1" },
      payload,
      providerCapabilities: { functionTools: true },
    }),
    async dispose() {
      for (const fiber of fibers.reverse()) {
        await fiber.dispose()
      }
    },
  }
}

function call(name, args) {
  return { type: "tool-call", id: `id-${name}`, name, arguments: JSON.stringify(args) }
}

test("memory_write 按 gate 注入：explicit 可用，implicit/缺省不可用", async () => {
  const explicitApp = await setup({ "memory-gate": { explicit: true, extract: null, count: 0 } })
  try {
    const names = explicitApp.toolSet.schemas.map((s) => s.name)
    assert.ok(names.includes("memory_read"))
    assert.ok(names.includes("memory_write"))
  } finally {
    await explicitApp.dispose()
  }

  const implicitApp = await setup({
    "memory-gate": { explicit: false, extract: "written", count: 2 },
  })
  try {
    const names = implicitApp.toolSet.schemas.map((s) => s.name)
    assert.ok(names.includes("memory_read"))
    assert.ok(!names.includes("memory_write"))
  } finally {
    await implicitApp.dispose()
  }

  const emptyApp = await setup({})
  try {
    const names = emptyApp.toolSet.schemas.map((s) => s.name)
    assert.ok(!names.includes("memory_write"))
  } finally {
    await emptyApp.dispose()
  }
})

test("memory_read 检索并只记录 Long 召回单元", async () => {
  const app = await setup({})
  try {
    const result = await app.toolSet.execute(call("memory_read", { query: "小明", mode: "weak" }))
    assert.equal(result.isError, false)
    assert.deepEqual(result.data, {
      units: [
        {
          unitType: "overview",
          unitId: "b1",
          blockId: "b1",
          recalledContent: { title: "小明", summary: "s", overviewBody: "o" },
        },
        {
          unitType: "detail",
          unitId: "d1",
          blockId: "b1",
          recalledContent: { summary: "ds", body: "db" },
        },
      ],
    })
    assert.equal(app.ctx.memoryRead.last.scope.memorySpaceId, "space1")
    assert.equal(app.ctx.memoryRead.last.mode, "weak")
  } finally {
    await app.dispose()
  }
})

test("检索正文 → 工具事件 JSON → feedback → 引擎保持相同字段和内容", async () => {
  const inputs = []
  const app = await setup(
    {},
    {
      async judgeSession(input) {
        inputs.push(input)
        return {
          feedbackType: "confirmed",
          evidenceTurnNos: [2],
          judgementData: {},
          judgementVersion: 1,
        }
      },
    },
  )
  try {
    const result = await app.toolSet.execute(call("memory_read", { query: "小明", mode: "strong" }))
    assert.equal(result.isError, false)
    const modelContent = JSON.parse(result.content).long[0]
    // 模拟 Session tool_result.data 的持久化、读取；不手写第二份召回数据。
    const eventData = JSON.parse(JSON.stringify(result.data))
    await app.ctx.memoryFeedback.settleSessionFeedback({
      userId: "u1",
      memorySpaceId: "space1",
      sessionId: "s1",
      recalls: [{ turnNo: 1, turnId: "t1", units: eventData.units }],
      conversation: [
        { turnNo: 1, userText: "小明最近怎么样", assistantText: "小明的情况是 o，补充信息是 db。" },
        { turnNo: 2, userText: "对，就是这样", assistantText: "好的" },
      ],
    })
    assert.equal(inputs.length, 2)
    const overview = inputs.find((input) => input.unitType === "overview")
    const detail = inputs.find((input) => input.unitType === "detail")
    const { details, ...overviewContent } = modelContent
    assert.deepEqual(overview.recalledContent, overviewContent)
    assert.deepEqual(detail.recalledContent, details[0])
    assert.deepEqual(overview.recallSnapshots, [{ ...eventData.units[0], turnNo: 1, turnId: "t1" }])
    assert.deepEqual(detail.recallSnapshots, [{ ...eventData.units[1], turnNo: 1, turnId: "t1" }])
    assert.deepEqual(overview.recallAssistantTurns, [
      { turnNo: 1, assistantText: "小明的情况是 o，补充信息是 db。" },
    ])
    assert.deepEqual(
      overview.relevantTurns.map((turn) => turn.turnNo),
      [2],
    )
  } finally {
    await app.dispose()
  }
})

test("memory_write 写库主模型提供的草稿", async () => {
  const app = await setup({ "memory-gate": { explicit: true } })
  try {
    const result = await app.toolSet.execute(
      call("memory_write", {
        memories: [{ title: "苹果", summary: "喜欢苹果", body: "- 喜欢苹果" }],
      }),
    )
    assert.equal(result.isError, false)
    assert.deepEqual(JSON.parse(result.content), { kind: "written", count: 2 })
    assert.equal(app.ctx.memoryWrite.last.drafts.length, 1)
    assert.equal(app.ctx.memoryWrite.last.drafts[0].title, "苹果")
  } finally {
    await app.dispose()
  }
})

test("collectRecallUnits / formatReadResult / isGateExplicit 纯函数", () => {
  assert.equal(isGateExplicit({ explicit: true }), true)
  assert.equal(isGateExplicit({ explicit: false }), false)
  assert.equal(isGateExplicit(undefined), false)

  const result = {
    status: "COMPLETE",
    fast: {
      titleSucceeded: true,
      vectorSucceeded: true,
      hits: [{ record: { title: "t", summary: "s", body: "b" } }],
    },
    long: {
      status: "COMPLETE",
      blocks: [
        {
          blockId: "b1",
          title: "小明",
          summary: "s",
          overviewBody: "o",
          details: [{ detailId: "d1", summary: "ds", body: "db" }],
        },
      ],
    },
  }
  assert.deepEqual(collectRecallUnits(result), [
    {
      unitType: "overview",
      unitId: "b1",
      blockId: "b1",
      recalledContent: { title: "小明", summary: "s", overviewBody: "o" },
    },
    {
      unitType: "detail",
      unitId: "d1",
      blockId: "b1",
      recalledContent: { summary: "ds", body: "db" },
    },
  ])
  assert.deepEqual(formatReadResult(result), {
    status: "COMPLETE",
    fast: [{ title: "t", summary: "s", body: "b" }],
    long: [
      { title: "小明", summary: "s", overviewBody: "o", details: [{ summary: "ds", body: "db" }] },
    ],
  })
})
