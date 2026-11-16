// 内存 mock：memorySpace / memoryRead / memoryWrite / memoryScheduler，供测试与示例复用
// （不连真库、不调真实模型、不真跑调度器）。
import { Service } from "cordis"

/** 模拟 ctx.memorySpace：按 userId+deviceId 记住空间，首次创建、之后复用。 */
export class FakeMemorySpace extends Service {
  constructor(ctx) {
    super(ctx, "memorySpace")
    this.bindings = new Map() // `${userId}:${deviceId}` -> memorySpaceId
    this.createdSpaces = []
    this.nextId = 0
  }

  async resolveOrCreateMemorySpace(userId, deviceId) {
    const key = `${userId}:${deviceId}`
    const existing = this.bindings.get(key)
    if (existing !== undefined) {
      return { memorySpaceId: existing, created: false }
    }
    this.nextId += 1
    const memorySpaceId = `space-${this.nextId}`
    this.bindings.set(key, memorySpaceId)
    this.createdSpaces.push({ userId, deviceId, memorySpaceId })
    return { memorySpaceId, created: true }
  }
}

/** 模拟 ctx.memoryRead：记录 search 调用并返回固定的 Fast/Long 命中。 */
export class FakeMemoryRead extends Service {
  constructor(ctx) {
    super(ctx, "memoryRead")
    this.calls = []
  }

  async search(input) {
    this.calls.push(input)
    return {
      status: "COMPLETE",
      fast: {
        titleSucceeded: true,
        vectorSucceeded: true,
        hits: [
          {
            record: { fastId: "f1", title: "咖啡偏好", summary: "用户喝冰美式", body: "- 用户喝冰美式。" },
            matchedBy: ["VECTOR"],
            vectorScore: 0.9,
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
            summary: "初中同学",
            overviewBody: "小明是初中同学。",
            reason: "TITLE_MATCH",
            score: null,
            details: [{ detailId: "d1", summary: "行程", body: "上海 BW", score: null }],
          },
        ],
      },
    }
  }
}

/** 模拟 ctx.memoryWrite：记录 write 调用并返回构造好的 FastRecord。 */
export class FakeMemoryWrite extends Service {
  constructor(ctx) {
    super(ctx, "memoryWrite")
    this.calls = []
    this.nextId = 0
  }

  async write(input) {
    this.nextId += 1
    const writeId = `write-${this.nextId}`
    const records = input.drafts.map((draft, index) => ({
      fastId: `fast-${this.nextId}-${index}`,
      writeId,
      userId: input.scope.userId,
      memorySpaceId: input.scope.memorySpaceId,
      sessionId: input.sessionId,
      turnId: input.turnId,
      createdAt: "2026-11-14T00:00:00.000Z",
      title: draft.title,
      titleKey: draft.title,
      summary: draft.summary,
      body: draft.body,
      consumedBatchId: null,
      consumedAt: null,
    }))
    this.calls.push({ input, writeId, records })
    return { kind: "written", writeId, records }
  }
}

/** 模拟 ctx.memoryScheduler：记录 setDailySchedule 调用，不真起后台扫描。 */
export class FakeMemoryScheduler extends Service {
  constructor(ctx) {
    super(ctx, "memoryScheduler")
    this.schedules = []
  }

  async setDailySchedule(input) {
    this.schedules.push(input)
    return {
      memorySpaceId: input.memorySpaceId,
      userId: input.userId,
      kind: "daily",
      enabled: true,
      dailyAt: input.dailyAt,
      timeZone: input.timeZone ?? null,
      minPendingFast: input.minPendingFast ?? 1,
      lastTriggeredAt: null,
      nextRunAt: null,
      createdAt: "2026-11-14T00:00:00.000Z",
      updatedAt: "2026-11-14T00:00:00.000Z",
    }
  }
}
