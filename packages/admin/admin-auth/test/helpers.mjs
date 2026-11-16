/* global structuredClone */
import { Context } from "cordis"
import { ToyStorage } from "toy-storage"
import { RelationalError, RelationalStorage } from "toy-storage-relational"
import { AdminAuth, adminAuthRelationalSchema } from "../lib/index.js"

function matches(row, filter) {
  switch (filter.type) {
    case "eq":
      return row[filter.field] === filter.value
    case "ne":
      return row[filter.field] !== filter.value
    case "lt":
      return row[filter.field] < filter.value
    case "lte":
      return row[filter.field] <= filter.value
    case "gt":
      return row[filter.field] > filter.value
    case "gte":
      return row[filter.field] >= filter.value
    case "in":
      return filter.values.includes(row[filter.field])
    case "isNull":
      return row[filter.field] === null
    case "isNotNull":
      return row[filter.field] !== null
    case "and":
      return filter.conditions.every((item) => matches(row, item))
    case "or":
      return filter.conditions.some((item) => matches(row, item))
    case "not":
      return !matches(row, filter.condition)
    default:
      throw new Error(`Unsupported filter ${filter.type}`)
  }
}

/** 通用内存测试替身：校验协议、主键与唯一索引，串行事务并支持回滚。 */
export class MemoryDatabase {
  constructor(schema = adminAuthRelationalSchema) {
    this.schema = schema
    this.capabilities = { transactions: true, atomicBatch: true, returning: true }
    this.rows = new Map(Object.keys(schema.tables).map((name) => [name, new Map()]))
    this.tail = Promise.resolve()
    this.protocol = new RelationalStorage(new Context())
  }

  execute(operation) {
    return this.transaction((tx) => tx.execute(operation))
  }

  async transaction(callback, options = {}) {
    const previous = this.tail
    let release
    this.tail = new Promise((resolve) => {
      release = resolve
    })
    await previous
    const snapshot = structuredClone(this.rows)
    try {
      const executor = {
        execute: async (operation) => {
          this.protocol.assertOperation(this.schema, operation)
          if (
            options.readOnly &&
            ["insert", "update", "delete", "upsert"].includes(operation.type)
          ) {
            throw new Error("Read-only transaction")
          }
          await this.beforeExecute?.(operation)
          return this.apply(snapshot, operation)
        },
      }
      const result = await callback(executor)
      if (!options.readOnly) {
        this.rows = snapshot
      }
      return result
    } finally {
      release()
    }
  }

  apply(tables, operation) {
    const table = tables.get(operation.table)
    const definition = this.schema.tables[operation.table]
    switch (operation.type) {
      case "get":
        return { row: structuredClone(table.get(operation.key)) }
      case "insert": {
        const row = structuredClone(operation.value)
        const key = row[definition.primaryKey]
        if (
          table.has(key) ||
          (definition.indexes ?? []).some(
            (index) =>
              index.unique &&
              [...table.values()].some((existing) =>
                index.fields.every((field) => existing[field] === row[field]),
              ),
          )
        ) {
          throw new RelationalError("duplicate-key", "Duplicate key")
        }
        table.set(key, row)
        return { row: structuredClone(row) }
      }
      case "find": {
        const rows = [...table.values()].filter(
          (row) => operation.where === undefined || matches(row, operation.where),
        )
        rows.sort((left, right) => {
          for (const order of operation.orderBy ?? []) {
            const a = left[order.field]
            const b = right[order.field]
            if (a !== b) {
              return (a < b ? -1 : 1) * (order.direction === "desc" ? -1 : 1)
            }
          }
          return 0
        })
        return { rows: structuredClone(rows.slice(0, operation.limit ?? rows.length)) }
      }
      case "count":
        return {
          count: [...table.values()].filter(
            (row) => operation.where === undefined || matches(row, operation.where),
          ).length,
        }
      case "update": {
        let affectedRows = 0
        for (const row of table.values()) {
          if (matches(row, operation.where)) {
            Object.assign(row, structuredClone(operation.patch))
            affectedRows++
          }
        }
        return { affectedRows }
      }
      case "delete": {
        let affectedRows = 0
        for (const [key, row] of table) {
          if (matches(row, operation.where)) {
            table.delete(key)
            affectedRows++
          }
        }
        return { affectedRows }
      }
      default:
        throw new Error(`Unsupported operation ${operation.type}`)
    }
  }
}

export async function setup(config = {}, database = new MemoryDatabase()) {
  const ctx = new Context()
  const fibers = []
  try {
    fibers.push(await ctx.plugin(ToyStorage))
    fibers.push(await ctx.plugin(RelationalStorage))
    ctx.storage.register("relational", "main", database)
    fibers.push(await ctx.plugin(AdminAuth, config))
    return {
      ctx,
      auth: ctx.adminAuth,
      database,
      async dispose() {
        for (const fiber of fibers.reverse()) {
          await fiber.dispose()
        }
      },
    }
  } catch (error) {
    for (const fiber of fibers.reverse()) {
      await fiber.dispose()
    }
    throw error
  }
}

export const PASSWORD = "a strong password 123!"
export const ROOT = { loginName: "root", password: PASSWORD }

export async function signedIn(config = {}, database) {
  const app = await setup(config, database)
  try {
    app.admin = await app.auth.bootstrap(ROOT)
    app.login = await app.auth.login(ROOT)
    return app
  } catch (error) {
    await app.dispose()
    throw error
  }
}
