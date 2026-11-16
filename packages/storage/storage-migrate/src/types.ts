/** 物理库中的一个列（introspect 结果，`dataType` 已归一化）。 */
export interface PhysicalColumn {
  readonly name: string
  readonly dataType: string
  readonly nullable: boolean
}

/** 物理库中的一张表。 */
export interface PhysicalTable {
  readonly name: string
  readonly columns: Map<string, PhysicalColumn>
  readonly indexNames: Set<string>
}

/** 物理库的完整结构快照。 */
export interface PhysicalSchema {
  readonly tables: Map<string, PhysicalTable>
}

/** 需要执行的结构变更（只做加法）。 */
export type DiffAction =
  | { readonly kind: "createTable"; readonly table: string }
  | { readonly kind: "addColumn"; readonly table: string; readonly column: string }
  | { readonly kind: "createIndex"; readonly table: string; readonly index: string }

/** 只报告、不自动执行的差异（破坏性 / 歧义变更）。 */
export type DiffReport =
  | { readonly kind: "extraTable"; readonly table: string }
  | { readonly kind: "extraColumn"; readonly table: string; readonly column: string }
  | {
      readonly kind: "typeMismatch"
      readonly table: string
      readonly column: string
      readonly expected: string
      readonly actual: string
    }
  | {
      readonly kind: "nullableMismatch"
      readonly table: string
      readonly column: string
      readonly expected: boolean
      readonly actual: boolean
    }
  | { readonly kind: "notNullWithoutDefault"; readonly table: string; readonly column: string }
  | { readonly kind: "extraIndex"; readonly table: string; readonly index: string }

/** 一次 diff 的完整结果。 */
export interface DiffResult {
  readonly actions: readonly DiffAction[]
  readonly reports: readonly DiffReport[]
}
