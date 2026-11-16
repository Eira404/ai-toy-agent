import { readFileSync } from "node:fs"
import { Pool } from "pg"
import { MigrateError } from "./error.js"
import { applyMigrations, planMigrations } from "./index.js"
import type { DiffAction, DiffReport } from "./types.js"

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const command = args[0] === "apply" ? "apply" : "plan"
  const rest = args.slice(1)

  const schemaPath = readFlag(rest, "--schema") ?? readFlag(rest, "-s")
  const schemaName = readFlag(rest, "--schema-name") ?? "public"
  const connectionString = process.env.DATABASE_URL

  if (connectionString === undefined || connectionString.trim().length === 0) {
    throw new MigrateError("connection-failed", "请设置环境变量 DATABASE_URL")
  }
  if (schemaPath === undefined) {
    throw new MigrateError("invalid-schema", "请通过 --schema <json 文件> 指定目标 Schema")
  }

  const desired = JSON.parse(readFileSync(schemaPath, "utf8"))
  const pool = new Pool({ connectionString })
  try {
    if (command === "apply") {
      const diff = await applyMigrations(pool, desired, { schemaName })
      printResult(diff.actions, diff.reports, true)
    } else {
      const { diff } = await planMigrations(pool, desired, { schemaName })
      printResult(diff.actions, diff.reports, false)
    }
  } finally {
    await pool.end()
  }
}

function readFlag(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name)
  if (index === -1) {
    return undefined
  }
  const value = args[index + 1]
  return value === undefined || value.startsWith("--") ? undefined : value
}

function printResult(actions: readonly DiffAction[], reports: readonly DiffReport[], applied: boolean): void {
  const header = applied ? "=== 已执行 ===" : "=== 迁移计划 ==="
  console.log(header)
  if (actions.length === 0) {
    console.log("  无结构变更")
  } else {
    console.log(`  将执行 ${actions.length} 项:`)
    for (const action of actions) {
      console.log(`    + ${describeAction(action)}`)
    }
  }
  if (reports.length > 0) {
    console.log(`  仅报告 ${reports.length} 项（不自动执行）:`)
    for (const report of reports) {
      console.log(`    ! ${describeReport(report)}`)
    }
  }
}

function describeAction(action: DiffAction): string {
  switch (action.kind) {
    case "createTable":
      return `createTable ${action.table}`
    case "addColumn":
      return `addColumn ${action.table}.${action.column}`
    case "createIndex":
      return `createIndex ${action.table}.${action.index}`
  }
}

function describeReport(report: DiffReport): string {
  switch (report.kind) {
    case "extraTable":
      return `extraTable ${report.table}`
    case "extraColumn":
      return `extraColumn ${report.table}.${report.column}`
    case "typeMismatch":
      return `typeMismatch ${report.table}.${report.column}（期望 ${report.expected}，实际 ${report.actual}）`
    case "nullableMismatch":
      return `nullableMismatch ${report.table}.${report.column}（期望 ${report.expected ? "可空" : "非空"}，实际 ${report.actual ? "可空" : "非空"}）`
    case "notNullWithoutDefault":
      return `notNullWithoutDefault ${report.table}.${report.column}（非空新列缺 default/backfill）`
    case "extraIndex":
      return `extraIndex ${report.table}.${report.index}`
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
