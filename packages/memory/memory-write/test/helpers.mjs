// 内存 mock：memoryFast 与 llm，供测试与示例复用（不连真库、不调真实模型）。
import { Service } from "cordis"

/** 模拟 ctx.memoryFast：记录 append 调用并返回构造好的 FastRecord。 */
export class FakeMemoryFast extends Service {
  constructor(ctx, config = {}) {
    super(ctx, "memoryFast")
    this.recent = config.recent ?? []
    this.appends = []
    this.nextIndex = 0
  }

  async listRecentBySession(_scope, _sessionId, limit) {
    return this.recent.slice(0, limit)
  }

  async append(input) {
    this.nextIndex += 1
    const writeId = `write-${this.nextIndex}`
    const records = input.drafts.map((draft, index) => ({
      fastId: `fast-${this.nextIndex}-${index}`,
      writeId,
      userId: input.scope.userId,
      memorySpaceId: input.scope.memorySpaceId,
      sessionId: input.sessionId,
      turnId: input.turnId,
      createdAt: "2026-11-09T00:00:00.000Z",
      title: draft.title,
      titleKey: draft.title,
      summary: draft.summary,
      body: draft.body,
      consumedBatchId: null,
      consumedAt: null,
    }))
    this.appends.push({ input, writeId, records })
    return { writeId, records }
  }
}

/** 模拟 ctx.llm：按 `responses` 队列依次返回数据或抛错。 */
export class FakeLlm extends Service {
  constructor(ctx, config = {}) {
    super(ctx, "llm")
    this.responses = config.responses ?? []
    this.calls = []
  }

  async generate(options) {
    this.calls.push(options)
    const response = this.responses.shift()
    if (response instanceof Error) {
      throw response
    }
    const data = response ?? { memories: [] }
    return {
      content: [{ type: "text", text: JSON.stringify(data) }],
      finish: { kind: "stop" },
    }
  }
}
