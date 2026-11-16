import type { Pool } from "pg"
import type { RelationalSchemaDefinition } from "toy-storage-relational"
import { actionSqls } from "./ddl.js"
import { diffSchema } from "./diff.js"
import { introspectSchema } from "./introspect.js"
import type { DiffResult } from "./types.js"

export { MigrateError } from "./error.js"
export type { MigrateErrorCode } from "./error.js"
export { actionSqls } from "./ddl.js"
export { diffSchema } from "./diff.js"
export { introspectSchema } from "./introspect.js"
export type {
  DiffAction,
  DiffReport,
  DiffResult,
  PhysicalColumn,
  PhysicalSchema,
  PhysicalTable,
} from "./types.js"

/** migrate 的运行参数。 */
export interface MigrateOptions {
  /** PostgreSQL schema 名，默认 `public`。 */
  readonly schemaName?: string
}

/** 一次 plan 的结果：diff + 每个 action 对应的 SQL 语句列表。 */
export interface PlanResult {
  readonly diff: DiffResult
  readonly sql: readonly (readonly string[])[]
}

/**
 * 连接、对比并生成 SQL 计划（不执行）。
 *
 * @param pool 已配置好的连接池（调用方负责关闭）。
 * @param desired 目标态 Schema。
 */
export async function planMigrations(
  pool: Pool,
  desired: RelationalSchemaDefinition,
  options: MigrateOptions = {},
): Promise<PlanResult> {
  const schemaName = options.schemaName ?? "public"
  const client = await pool.connect()
  try {
    const physical = await introspectSchema(client, schemaName)
    const diff = diffSchema(desired, physical)
    const sql = diff.actions.map((action) => [...actionSqls(schemaName, desired, action)])
    return { diff, sql }
  } finally {
    client.release()
  }
}

/**
 * 连接、对比并执行（所有 action 在一个事务内，失败回滚）。
 *
 * @returns 本次实际应用的 diff（含 reports）。
 */
export async function applyMigrations(
  pool: Pool,
  desired: RelationalSchemaDefinition,
  options: MigrateOptions = {},
): Promise<DiffResult> {
  const schemaName = options.schemaName ?? "public"
  const client = await pool.connect()
  try {
    const physical = await introspectSchema(client, schemaName)
    const diff = diffSchema(desired, physical)

    await client.query("BEGIN")
    try {
      for (const action of diff.actions) {
        for (const statement of actionSqls(schemaName, desired, action)) {
          await client.query(statement)
        }
      }
      await client.query("COMMIT")
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined)
      throw error
    }
    return diff
  } finally {
    client.release()
  }
}
