/**
 * LongMemEval adapter：`mode = independent`，文本 500 题。
 *
 * 数据为 LongMemEval（ICLR 2025）官方 JSON（数组或 `{data:[...]}`），每个实例含
 * `question_id / question_type / question / answer / haystack_sessions / haystack_session_ids`。
 * 每题一个独立记忆空间（`spaceKey = question_id`），该题的 haystack 是该空间的历史
 * （`sessionId = <question_id>:<session_id>`），避免不同题目记忆互相污染。
 */
import { readFile } from "node:fs/promises"
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

interface LongMemEvalTurn {
  role: string
  content: string
}

interface LongMemEvalInstance {
  question_id: string
  question_type: string
  question: string
  answer: string
  answer_session_ids?: string[]
  haystack_session_ids?: string[]
  haystack_sessions: LongMemEvalTurn[][]
}

export interface LongMemEvalAdapterOptions {
  /** 数据文件路径（必填，默认由 CLI 传入）。 */
  readonly dataFile: string
  readonly start?: number
  readonly limit?: number
}

export class LongMemEvalV1Adapter implements BenchmarkAdapter {
  readonly id = "longmemeval_v1"
  readonly mode = "independent" as const

  private readonly dataFile: string
  private readonly start: number
  private readonly limit: number | undefined

  private raw: LongMemEvalInstance[] = []

  constructor(options: LongMemEvalAdapterOptions) {
    this.dataFile = options.dataFile
    this.start = options.start ?? 0
    this.limit = options.limit
  }

  async load(): Promise<void> {
    const text = await readFile(this.dataFile, "utf8")
    const dataset = JSON.parse(text) as unknown
    const instances = Array.isArray(dataset)
      ? (dataset as LongMemEvalInstance[])
      : ((dataset as { data?: LongMemEvalInstance[] }).data ?? [])
    const sliced = instances.slice(
      this.start,
      this.limit === undefined ? undefined : this.start + this.limit,
    )
    this.raw = sliced
  }

  normalize(): Normalized {
    const items: IndependentItem[] = this.raw.map((instance) => {
      const sessions = instance.haystack_sessions ?? []
      const history: Session[] = sessions.map((turns, i) => {
        const sid = instance.haystack_session_ids?.[i] ?? `sess-${i}`
        return {
          sessionId: `${instance.question_id}:${sid}`,
          turns: turns.map((t) => ({ role: t.role === "user" ? "user" : "assistant", content: t.content })),
        }
      })
      return { spaceKey: instance.question_id, questionId: instance.question_id, history }
    })

    const questions: Question[] = this.raw.map((instance) => ({
      questionId: instance.question_id,
      type: instance.question_type,
      text: instance.question,
      gold: instance.answer,
      ...(instance.answer_session_ids === undefined
        ? {}
        : { evidenceIds: instance.answer_session_ids }),
    }))
    return { mode: this.mode, items, questions }
  }

  buildTurns(item: IndependentItem): readonly TurnExtraction[] {
    return buildTurnsFromHistory(item.history)
  }

  judge(question: Question, predicted: string, gold: string): JudgePrompt {
    const abstention = question.questionId.endsWith("_abs")
    const system = abstention
      ? "你是记忆系统评测者。本题是不可回答题（question_id 以 _abs 结尾）：模型正确识别出信息不完整、" +
        "无法确定或不知道，判为正确；若模型给出了确定答案，判为错误。只输出 JSON。"
      : "你是记忆系统评测者，判断模型回答是否包含正确答案。与标准答案等价、或包含得到正确答案所需的" +
        "中间步骤也算正确；只包含答案的子集则算错误。只输出 JSON。"
    return {
      system,
      user: `题目：${question.text}\n标准答案：${gold}\n模型回答：${predicted}`,
    }
  }

  metricGroups(): readonly string[] {
    const seen: string[] = []
    for (const instance of this.raw) {
      if (!seen.includes(instance.question_type)) {
        seen.push(instance.question_type)
      }
    }
    return seen
  }
}

export default LongMemEvalV1Adapter
