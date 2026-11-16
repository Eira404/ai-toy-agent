/* global console */
import { Context } from "cordis"
import { ToyStorage } from "toy-storage"
import {
  LongMemory,
  longRelationalSchema,
  defineLongVectorSchema,
} from "toy-memory-long"
import { DIM, FakeRelational, FakeVector, fakeVector } from "../test/helpers.mjs"

const ctx = new Context()
const fibers = []
fibers.push(await ctx.plugin(ToyStorage))
fibers.push(await ctx.plugin(FakeRelational, { schema: longRelationalSchema }))
fibers.push(await ctx.plugin(FakeVector, { schema: defineLongVectorSchema(DIM) }))
fibers.push(await ctx.plugin(LongMemory))

const scope = { userId: "u1", memorySpaceId: "space1" }
const value = { version: "v1", state: { value: 0.8 } }

try {
  // 1. 创建记忆块 + 一条细节（价值状态由价值遗忘系统结算后传入）
  const created = await ctx.memoryLong.applyChanges(scope, {
    changes: [
      {
        kind: "CREATE",
        content: {
          domain: "person",
          title: "小明",
          aliases: ["明哥"],
          summary: "用户关于初中同学小明的记忆",
          overviewBody: "小明是用户的初中同学，目前在上海工作。",
          lifecycleStatus: "active",
        },
        summaryVector: fakeVector("用户关于初中同学小明的记忆"),
        value,
        details: [
          {
            kind: "CREATE",
            summary: "用户与小明去上海的信息",
            summaryVector: fakeVector("用户与小明去上海的信息"),
            body: "用户与小明于 2026 年 7 月一起去了上海 BW。",
            lifecycleStatus: "active",
            value,
          },
        ],
      },
    ],
  })
  const blockId = created.blockIds[0]
  console.log("applyChanges 创建块:", blockId)

  // 2. 读回完整块
  const block = await ctx.memoryLong.getBlock(scope, blockId)
  console.log("getBlock:", block.title, block.aliases.join("/"), block.details.length, "条细节")

  // 3. 弱检索：title 完全匹配（不依赖向量）
  const byTitle = await ctx.memoryLong.searchWeak({ scope, query: "  小明 ", queryVector: null })
  console.log("弱检索 title 命中:", byTitle.blocks.map((hit) => `${hit.title}[${hit.reason}]`).join(", "))

  // 4. 弱检索：向量命中块并命中细节（Query 向量由 toy-memory-read 算好传入）
  const byVector = await ctx.memoryLong.searchWeak({
    scope,
    query: "上海",
    queryVector: fakeVector("用户与小明去上海的信息"),
  })
  console.log(
    "弱检索向量命中:",
    byVector.blocks.map((hit) => `${hit.title}[${hit.reason}] 细节=${hit.details.length}`).join(", "),
  )

  // 5. 强检索：平级向量
  const strong = await ctx.memoryLong.searchStrong({
    scope,
    query: "上海 BW",
    queryVector: fakeVector("用户与小明去上海的信息"),
  })
  console.log(
    "强检索命中:",
    strong.blocks.map((hit) => `${hit.title}[${hit.reason}]`).join(", "),
  )

  // 6. 冻结快照（供 Daily 阶段六/七）
  const snapshot = await ctx.memoryLong.freezeSnapshot(scope)
  console.log("freezeSnapshot:", snapshot.length, "个有效块")

  // 7. 归档整块
  const archived = await ctx.memoryLong.applyChanges(scope, {
    changes: [{ kind: "ARCHIVE", blockId, oldValue: value }],
  })
  console.log("applyChanges 归档:", archived.archivedBlockIds.join(", "))
} finally {
  for (const fiber of fibers.reverse()) {
    await fiber.dispose()
  }
}
