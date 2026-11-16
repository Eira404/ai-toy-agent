import assert from "node:assert/strict"
import test from "node:test"
import { Context } from "cordis"
import { AgentService } from "toy-agent"
import { AgentLoop } from "toy-agent-loop"
import { JevAdapter, JevRuntime } from "toy-jev"
import { LlmAdapter, LlmRuntime } from "toy-llm"
import { SessionData } from "toy-session-data"
import { ToySession } from "toy-session"
import { ToolRegistry } from "toy-tools"
import {
  deriveModeState,
  INITIAL_MODE_STATE,
  nextEnglishPracticeMode,
  readPreviousMode,
  ToyModeAnalysis,
} from "toy-mode-analysis"

// 主循环回答：返回一句固定文本即可。
class FakeModel extends LlmAdapter {
  async *stream() {
    yield { type: "text-delta", index: 0, text: "ok" }
    yield { type: "finish", reason: { kind: "stop" } }
  }
}

// JEV 替身：按调用顺序返回预设的四信号，并记录每次收到的 state 文本。
class FakeJevAdapter extends JevAdapter {
  constructor(signals) {
    super()
    this.signals = [...signals]
    this.states = []
  }

  async invoke({ state }) {
    this.states.push(state)
    const s = this.signals.shift() ?? { english: 0, startContinue: 0, stop: 0, relevantChinese: 0 }
    return {
      model: "fake",
      answers: {
        english: { type: "noul", noul: s.english },
        startContinue: { type: "noul", noul: s.startContinue },
        stop: { type: "noul", noul: s.stop },
        relevantChinese: { type: "noul", noul: s.relevantChinese },
      },
    }
  }
}

test("mode-analysis 判断并跨轮持久化模式", async () => {
  const ctx = new Context()
  await ctx.plugin(SessionData)
  await ctx.plugin(ToySession)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(ToolRegistry)
  await ctx.plugin(AgentService)
  await ctx.plugin(AgentLoop, { provider: "local", model: "demo" })
  await ctx.plugin(JevRuntime)
  await ctx.plugin(ToyModeAnalysis)
  ctx.llm.registerAdapter("local", new FakeModel())
  const jev = new FakeJevAdapter([
    { english: 1, startContinue: 0, stop: 0, relevantChinese: 0 }, // what is your name → 是
    { english: 0, startContinue: 0, stop: 0, relevantChinese: 0 }, // 介绍一下宇宙 → 待退出
    { english: 0, startContinue: 0, stop: 0, relevantChinese: 0 }, // 今天天气怎么样 → 待退出
    { english: 1, startContinue: 0, stop: 0, relevantChinese: 0 }, // Let's continue → 是
    { english: 0, startContinue: 0, stop: 1, relevantChinese: 0 }, // 不练了 → 否
  ])
  ctx.jev.registerAdapter("fake", jev)

  try {
    const sessionId = await ctx.session.createSession({ userId: "u1", deviceId: "d1" })

    const turn1 = await ctx.session.runTurn(sessionId, { message: { text: "what is your name" } })
    assert.deepEqual(turn1.result.preprocessing.data.mode, {
      defaultMode: "no",
      englishPractice: "yes",
    })

    const turn2 = await ctx.session.runTurn(sessionId, {
      message: { text: "介绍一下宇宙是怎么产生的" },
    })
    assert.deepEqual(turn2.result.preprocessing.data.mode, {
      defaultMode: "no",
      englishPractice: "pending-exit",
    })

    const turn3 = await ctx.session.runTurn(sessionId, { message: { text: "今天天气怎么样" } })
    assert.deepEqual(turn3.result.preprocessing.data.mode, {
      defaultMode: "no",
      englishPractice: "pending-exit",
    })

    const turn4 = await ctx.session.runTurn(sessionId, {
      message: { text: "Let's continue in English" },
    })
    assert.deepEqual(turn4.result.preprocessing.data.mode, {
      defaultMode: "no",
      englishPractice: "yes",
    })

    const turn5 = await ctx.session.runTurn(sessionId, { message: { text: "不练了，结束吧" } })
    assert.deepEqual(turn5.result.preprocessing.data.mode, {
      defaultMode: "yes",
      englishPractice: "no",
    })

    // 上一轮模式通过 mode_state 事件恢复，并写进了后续 JEV 的 state 文本。
    assert.match(jev.states[0], /英语对练=否/)
    assert.match(jev.states[1], /英语对练=是/)
    assert.match(jev.states[2], /英语对练=待退出/)
    assert.match(jev.states[3], /英语对练=待退出/)
    assert.match(jev.states[4], /英语对练=是/)
  } finally {
    await ctx.fiber.dispose()
  }
})

test("nextEnglishPracticeMode / deriveModeState / readPreviousMode 的纯逻辑", () => {
  const none = { english: 0, startContinue: 0, stop: 0, relevantChinese: 0 }

  // 明确结束 → 否（优先级最高）
  assert.equal(nextEnglishPracticeMode("yes", { ...none, stop: 1 }), "no")
  assert.equal(nextEnglishPracticeMode("pending-exit", { ...none, stop: 1 }), "no")
  // 说英文 / 想开始 → 是
  assert.equal(nextEnglishPracticeMode("no", { ...none, english: 1 }), "yes")
  assert.equal(nextEnglishPracticeMode("no", { ...none, startContinue: 1 }), "yes")
  // 未进入且无触发 → 否
  assert.equal(nextEnglishPracticeMode("no", none), "no")
  // 已进入且中文相关提问 → 是
  assert.equal(nextEnglishPracticeMode("yes", { ...none, relevantChinese: 1 }), "yes")
  // 已进入且无关中文 → 待退出
  assert.equal(nextEnglishPracticeMode("yes", none), "pending-exit")
  // 待退出 + 说英文 → 是
  assert.equal(nextEnglishPracticeMode("pending-exit", { ...none, english: 1 }), "yes")
  // 待退出 + 无关中文 → 待退出
  assert.equal(nextEnglishPracticeMode("pending-exit", none), "pending-exit")

  assert.deepEqual(deriveModeState("no"), { defaultMode: "yes", englishPractice: "no" })
  assert.deepEqual(deriveModeState("yes"), { defaultMode: "no", englishPractice: "yes" })

  assert.deepEqual(readPreviousMode([]), INITIAL_MODE_STATE)
  const previousTurns = [
    {
      events: [{ eventType: "mode_state", payload: { defaultMode: "no", englishPractice: "yes" } }],
    },
    {
      events: [
        { eventType: "user_message", payload: { text: "hi" } },
        {
          eventType: "mode_state",
          payload: { defaultMode: "no", englishPractice: "pending-exit" },
        },
      ],
    },
  ]
  assert.deepEqual(readPreviousMode(previousTurns), {
    defaultMode: "no",
    englishPractice: "pending-exit",
  })
})
