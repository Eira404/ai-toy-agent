import type { PoolClient } from "pg"
import { normalizePgType } from "./sql.js"
import type { PhysicalColumn, PhysicalSchema, PhysicalTable } from "./types.js"

/** 读取某个 PostgreSQL schema 下的表、列与索引，得到物理库结构快照。 */
export async function introspectSchema(client: PoolClient, schemaName: string): Promise<PhysicalSchema> {
  const tables = new Map<string, PhysicalTable>()

  const columns = await client.query(
    `SELECT table_name, column_name, data_type, is_nullable
     FROM information_schema.columns
     WHERE table_schema = $1
     ORDER BY table_name, ordinal_position`,
    [schemaName],
  )
  for (const row of columns.rows) {
    const tableName = String(row.table_name)
    const columnName = String(row.column_name)
    const table = tables.get(tableName) ?? { name: tableName, columns: new Map(), indexNames: new Set() }
    tables.set(tableName, table)

    const column: PhysicalColumn = {
      name: columnName,
      dataType: normalizePgType(String(row.data_type)),
      nullable: row.is_nullable === "YES",
    }
    table.columns.set(columnName, column)
  }

  const indexes = await client.query(
    `SELECT tablename, indexname FROM pg_indexes WHERE schemaname = $1`,
    [schemaName],
  )
  for (const row of indexes.rows) {
    const tableName = String(row.tablename)
    const table = tables.get(tableName)
    if (table !== undefined) {
      table.indexNames.add(String(row.indexname))
    }
  }

  return { tables }
}
