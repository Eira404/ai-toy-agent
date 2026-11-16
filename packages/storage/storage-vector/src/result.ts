import type { VectorOperation, VectorRecord } from "./operation.js"

/** 搜索命中的记录摘要与距离，距离越小越接近查询向量。 */
export interface VectorMatch extends Omit<VectorRecord, "vector"> {
  readonly distance: number
}

/** 完整记录写入成功后的确认。 */
export interface VectorUpsertResult {
  readonly id: string
}

/** 按输入顺序返回成功写入的记录 ID。 */
export interface VectorUpsertManyResult {
  readonly ids: readonly string[]
}

/** 按 ID 查询的结果，记录不存在时返回 undefined。 */
export interface VectorGetResult {
  readonly record: VectorRecord | undefined
}

/** 实际删除的记录条数。 */
export interface VectorDeleteResult {
  readonly affectedRows: 0 | 1
}

/** 批量操作实际删除的记录条数。 */
export interface VectorDeleteManyResult {
  readonly affectedRows: number
}

/** Top K 结果按距离升序排列，同距离按 ID 升序排列。 */
export interface VectorSearchResult {
  readonly matches: readonly VectorMatch[]
}

interface VectorResultMap {
  upsert: VectorUpsertResult
  upsertMany: VectorUpsertManyResult
  get: VectorGetResult
  delete: VectorDeleteResult
  deleteMany: VectorDeleteManyResult
  search: VectorSearchResult
}

/** 所有向量操作可能返回的结果。 */
export type VectorResult = VectorResultOf<VectorOperation>

/** 根据输入操作的 type 推导对应的结果类型。 */
export type VectorResultOf<O extends VectorOperation> = VectorResultMap[O["type"]]
