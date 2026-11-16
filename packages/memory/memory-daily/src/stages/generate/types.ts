import type { LongDomain } from "toy-memory-long"
import type { LongCandidate } from "../consolidate-cross/types.js"

export type DetailOp =
  | { readonly kind: "UPDATE"; readonly detailId: string; readonly summary: string; readonly body: string }
  | { readonly kind: "DELETE"; readonly detailId: string }
  | { readonly kind: "CREATE"; readonly summary: string; readonly body: string }

/**
 * 阶段四输出（checkpoint stage 5）：每个目标块一份 Long 变化方案。
 *
 * - `candidates`：归属于该目标的全部 Long 候选（供阶段六独立验证用）；
 * - `sourceFastIds`：该目标全部候选来源的并集（粗粒度来源池，只审计不进正文）；
 * - CREATE 的 detailOps 阶段四为空、阶段五从 overview 溢出填充；UPDATE 的 detailOps 引用旧块已有 detailId。
 */
export type BlockChangePlan =
  | {
      readonly kind: "CREATE"
      readonly domain: LongDomain
      readonly title: string
      readonly aliases: readonly string[]
      readonly summary: string
      readonly overviewBody: string
      readonly detailOps: readonly DetailOp[]
      readonly sourceFastIds: readonly string[]
      readonly candidates: readonly LongCandidate[]
    }
  | {
      readonly kind: "UPDATE"
      readonly blockId: string
      readonly domain: LongDomain
      readonly title: string
      readonly aliases: readonly string[]
      readonly summary: string
      readonly overviewBody: string
      readonly detailOps: readonly DetailOp[]
      readonly sourceFastIds: readonly string[]
      readonly candidates: readonly LongCandidate[]
    }
