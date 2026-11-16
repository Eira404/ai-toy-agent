import { Service } from "cordis"
import { LlmAdapter } from "toy-llm"

/** 仅供 example/test 的注册槽：不模拟 Daily 编排，也不访问数据库。 */
class EngineSlot extends Service {
  constructor(ctx, name) {
    super(ctx, name)
    this.engine = null
  }

  registerValueEngine(engine) {
    if (this.engine !== null) {
      throw new Error("engine-already-registered")
    }
    this.engine = engine
    return () => {
      if (this.engine === engine) {
        this.engine = null
      }
    }
  }
}

export class ExampleFeedback extends EngineSlot {
  constructor(ctx) {
    super(ctx, "memoryFeedback")
  }
}

export class ExampleDaily extends EngineSlot {
  constructor(ctx) {
    super(ctx, "memoryDaily")
  }
}

/** 使用真实 LlmRuntime 消费流协议；结构化答案由示例显式提供，不调用远端。 */
export class ScriptedAdapter extends LlmAdapter {
  constructor(respond) {
    super()
    this.respond = respond
    this.calls = []
  }

  async *stream(options) {
    options.signal?.throwIfAborted()
    this.calls.push(options)
    const output = await this.respond(options)
    const block = { type: "text", text: JSON.stringify(output) }
    yield { type: "block-start", index: 0, blockType: "text" }
    yield { type: "text-delta", index: 0, text: block.text }
    yield { type: "block-end", index: 0, block }
    yield { type: "finish", reason: { kind: "stop" } }
  }
}
