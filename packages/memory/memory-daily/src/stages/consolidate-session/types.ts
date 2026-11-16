/**
 * 阶段一产出的 Session 候选（checkpoint stage 2）。
 *
 * `candidateTime` 与 `sourceFastIds` 由程序附加，LLM 只输出 title/summary/body。
 */
export interface SessionCandidate {
  readonly title: string
  readonly summary: string
  readonly body: string
  /** 产生该输出的本次 LLM 输入集合中最晚的 createdAt。 */
  readonly candidateTime: string
  /** 本次调用全部输入 Fast 的 ID 集合（粗粒度来源，非逐条对应）。 */
  readonly sourceFastIds: readonly string[]
}
