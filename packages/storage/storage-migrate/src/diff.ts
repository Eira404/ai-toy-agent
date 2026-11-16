import type { RelationalSchemaDefinition } from "toy-storage-relational"
import { columnSql } from "./sql.js"
import type { DiffAction, DiffReport, DiffResult, PhysicalSchema } from "./types.js"

/**
 * 对比「目标态 Schema」与「物理库结构」，产出：
 * - `actions`：可安全自动执行的加法（建表 / 加列 / 加索引）；
 * - `reports`：只报告、不自动执行的差异（删列 / 改类型 / 改约束 / 多余表列索引）。
 */
export function diffSchema(desired: RelationalSchemaDefinition, physical: PhysicalSchema): DiffResult {
  const actions: DiffAction[] = []
  const reports: DiffReport[] = []

  for (const [tableName, table] of Object.entries(desired.tables)) {
    const physicalTable = physical.tables.get(tableName)

    if (physicalTable === undefined) {
      actions.push({ kind: "createTable", table: tableName })
      for (const index of table.indexes ?? []) {
        actions.push({ kind: "createIndex", table: tableName, index: index.name })
      }
      continue
    }

    // 目标列缺失 → 加列；非空且无 default/backfill → 只能报告。
    for (const [columnName, column] of Object.entries(table.columns)) {
      const physicalColumn = physicalTable.columns.get(columnName)
      if (physicalColumn === undefined) {
        if (column.nullable !== true && column.default === undefined && column.backfill === undefined) {
          reports.push({ kind: "notNullWithoutDefault", table: tableName, column: columnName })
        } else {
          actions.push({ kind: "addColumn", table: tableName, column: columnName })
        }
        continue
      }

      const expectedType = columnSql(column).toLowerCase()
      if (expectedType !== physicalColumn.dataType) {
        reports.push({
          kind: "typeMismatch",
          table: tableName,
          column: columnName,
          expected: expectedType,
          actual: physicalColumn.dataType,
        })
      }

      const expectedNullable = column.nullable === true
      if (expectedNullable !== physicalColumn.nullable) {
        reports.push({
          kind: "nullableMismatch",
          table: tableName,
          column: columnName,
          expected: expectedNullable,
          actual: physicalColumn.nullable,
        })
      }
    }

    // 物理库多出来的列 → 报告（不自动 DROP）。
    for (const physicalColumnName of physicalTable.columns.keys()) {
      if (table.columns[physicalColumnName] === undefined) {
        reports.push({ kind: "extraColumn", table: tableName, column: physicalColumnName })
      }
    }

    // 索引：缺失 → 建；物理库多余（含主键 `<table>_pkey`）→ 报告。
    const expectedIndexNames = new Set<string>([
      `${tableName}_pkey`,
      ...(table.indexes ?? []).map((index) => `${tableName}_${index.name}`),
    ])
    for (const index of table.indexes ?? []) {
      const physicalName = `${tableName}_${index.name}`
      if (!physicalTable.indexNames.has(physicalName)) {
        actions.push({ kind: "createIndex", table: tableName, index: index.name })
      }
    }
    for (const physicalIndexName of physicalTable.indexNames) {
      if (!expectedIndexNames.has(physicalIndexName)) {
        reports.push({ kind: "extraIndex", table: tableName, index: physicalIndexName })
      }
    }
  }

  // 物理库里多出来的表 → 报告（不自动 DROP）。
  for (const physicalTableName of physical.tables.keys()) {
    if (desired.tables[physicalTableName] === undefined) {
      reports.push({ kind: "extraTable", table: physicalTableName })
    }
  }

  return { actions, reports }
}
