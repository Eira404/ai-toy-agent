import type { LongBlock, LongDomain } from "toy-memory-long"
import { unitKey } from "./unit.js"
import type { WeeklyStructureOp } from "./types.js"

/** 快照中的一条细节：正文 + 旧价值单元来源键。 */
export interface WeeklySnapshotDetail {
  readonly detailId: string
  readonly summary: string
  readonly body: string
  /** 旧价值单元来源键（`detail:{detailId}`），供价值迁移判断继承/初始化，不落库。 */
  readonly sourceKeys: readonly string[]
}

/**
 * 可变快照块：split/reclassify/merge/rename 在其上连续变换，并携带价值来源线索。
 *
 * 与 `LongBlock` 的区别：不含价值状态与时间戳，但多出 `overviewSourceKeys` /
 * `details[].sourceKeys`（旧单元来源）与 `ops`（已发生的结构操作）。
 */
export interface WeeklySnapshotBlock {
  readonly blockId: string
  readonly domain: LongDomain
  readonly title: string
  readonly aliases: readonly string[]
  readonly summary: string
  readonly overviewBody: string
  readonly details: readonly WeeklySnapshotDetail[]
  /** 旧价值单元来源键（`overview:{blockId}` 等），供价值迁移判断继承/初始化，不落库。 */
  readonly overviewSourceKeys: readonly string[]
  /** 该块经历的结构操作，KEEP 为空。 */
  readonly ops: readonly WeeklyStructureOp[]
}

/** 把冻结 Long 转成初始快照：每个单元携带自身旧键，ops 为空。 */
export function buildSnapshot(frozenLong: readonly LongBlock[]): WeeklySnapshotBlock[] {
  return frozenLong.map((block) => ({
    blockId: block.blockId,
    domain: block.domain,
    title: block.title,
    aliases: block.aliases,
    summary: block.summary,
    overviewBody: block.overviewBody,
    details: block.details.map((detail) => ({
      detailId: detail.detailId,
      summary: detail.summary,
      body: detail.body,
      sourceKeys: [unitKey("detail", detail.detailId)],
    })),
    overviewSourceKeys: [unitKey("overview", block.blockId)],
    ops: [],
  }))
}
