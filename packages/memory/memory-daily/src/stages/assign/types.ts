import type { LongDomain } from "toy-memory-long"

export type TargetKind = "EXISTING" | "NEW"

/**
 * 阶段三输出（checkpoint stage 4）：每条 Long 候选的归属方案。
 *
 * `targetBlockId`：EXISTING 时是已有块 ID，NEW 时是本批临时 newBlockId
 * （`new-{candidateId}`，供阶段四聚合目标）。
 */
export interface CandidateAssignment {
  readonly candidateId: string
  readonly domain: LongDomain
  readonly targetKind: TargetKind
  readonly targetBlockId: string
}
