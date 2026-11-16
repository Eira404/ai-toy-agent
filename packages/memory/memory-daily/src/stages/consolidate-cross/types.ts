/**
 * 阶段二产出的 Long 候选（checkpoint stage 3）。
 *
 * `candidateId` 是阶段二/三期间有效的本批唯一标识；`candidateTime` 与
 * `sourceFastIds` 由程序附加，LLM 只输出 title/summary/body。
 */
export interface LongCandidate {
  readonly candidateId: string
  readonly title: string
  readonly summary: string
  readonly body: string
  /** 产生该输出的输入候选中最晚的 candidateTime。 */
  readonly candidateTime: string
  /** 本组全部输入候选 sourceFastIds 的并集（粗粒度来源）。 */
  readonly sourceFastIds: readonly string[]
}
