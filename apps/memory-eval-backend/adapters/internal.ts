/**
 * 内部中文题 adapter：`mode = independent`，每题一个空间（`deviceId = questionId`）。
 *
 * 数据文件为 `data/internal-questions.json`，题目覆盖 5 个能力标签：
 * factual / temporal / update / preference / abstention。
 */
import { readFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { buildTurnsFromHistory } from "./helpers.ts"
import type {
  BenchmarkAdapter,
  IndependentItem,
  JudgePrompt,
  Normalized,
  Question,
  Session,
  TurnExtraction,
} from "./types.ts"

const __dirname = dirname(fileURLToPath(import.meta.url))

/** 5 个能力标签，即 §8「分能力得分」的分组。 */
export const INTERNAL_METRIC_GROUPS = ["factual", "temporal", "update", "preference", "abstention"] as const

interface InternalRawQuestion {
  questionId: string
  type: string
  question: string
  gold: string
  sessions: { sessionId: string; turns: { role: "user" | "assistant"; content: string }[] }[]
}

export interface InternalAdapterOptions {
  /** 数据文件路径；默认 `data/internal-questions.json`。 */
  readonly dataFile?: string
  /** 起始题号（含），默认 0。 */
  readonly start?: number
  /** 处理题数上限；省略则全部。 */
  readonly limit?: number
}

export class InternalAdapter implements BenchmarkAdapter {
  readonly id = "internal"
  readonly mode = "independent" as const

  private readonly dataFile: string
  private readonly start: number
  private readonly limit: number | undefined

  private raw: InternalRawQuestion[] = []

  constructor(options: InternalAdapterOptions = {}) {
    this.dataFile = options.dataFile ?? join(__dirname, "..", "data", "internal-questions.json")
    this.start = options.start ?? 0
    this.limit = options.limit
  }

  async load(): Promise<void> {
    const text = await readFile(this.dataFile, "utf8")
    const parsed = JSON.parse(text) as InternalRawQuestion[]
    const sliced = parsed.slice(this.start, this.limit === undefined ? undefined : this.start + this.limit)
    this.raw = sliced
  }

  normalize(): Normalized {
    const items: IndependentItem[] = this.raw.map((q) => ({
      spaceKey: q.questionId,
      questionId: q.questionId,
      history: q.sessions.map(toSession),
    }))
    const questions: Question[] = this.raw.map((q) => ({
      questionId: q.questionId,
      type: q.type,
      text: q.question,
      gold: q.gold,
    }))
    return { mode: this.mode, items, questions }
  }

  buildTurns(item: IndependentItem): readonly TurnExtraction[] {
    return buildTurnsFromHistory(item.history)
  }

  judge(question: Question, predicted: string, gold: string): JudgePrompt {
    return {
      system:
        "你是记忆系统评测者，判断模型回答是否正确。规则：若标准答案为「无法确定」，且模型拒绝回答" +
        "（答「无法确定/不知道/没有相关信息」等），判为正确；若标准答案存在，但模型拒绝回答，判为错误；" +
        "其余情况按事实是否与标准答案一致判断。只输出 JSON。",
      user: `题目：${question.text}\n标准答案：${gold}\n模型回答：${predicted}`,
    }
  }

  metricGroups(): readonly string[] {
    return INTERNAL_METRIC_GROUPS
  }
}

export default InternalAdapter

// ---------------------------------------------------------------------------
// 模块级辅助
// ---------------------------------------------------------------------------

function toSession(raw: InternalRawQuestion["sessions"][number]): Session {
  return {
    sessionId: raw.sessionId,
    turns: raw.turns.map((t) => ({ role: t.role, content: t.content })),
  }
}
