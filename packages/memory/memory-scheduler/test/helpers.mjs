// 内存 mock：关系型 + 调度器依赖的 memoryDaily / memoryFast 假实现。
import { Service } from "cordis"

function compare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0
}

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
    case "in":
      return filter.values.includes(row[filter.field])
    case "isNull":
      return row[filter.field] === null || row[filter.field] === undefined
    case "and":
      return filter.conditions.every((item) => matches(row, item))
    case "or":
      return filter.conditions.some((item) => matches(row, item))
    default:
      throw new Error(`fake relational 不支持 filter ${filter.type}`)
  }
}

function violatesUniqueIndex(schema, tableName, table, row, ignoredKey) {
  const indexes = schema.tables[tableName].indexes ?? []
  for (const index of indexes) {
    if (!index.unique) {
      continue
    }
    const key = index.fields.map((field) => row[field]).join("\u0000")
    if (key === ignoredKey) {
      continue
    }
    for (const [existingKey, existing] of table) {
      const existingIndexKey = index.fields.map((field) => existing[field]).join("\u0000")
      if (existingIndexKey === key) {
        return true
      }
    }
  }
  return false
}

/** 内存关系型 adapter，覆盖 scheduler 包用到的最小操作集。 */
export class FakeRelational extends Service {
  static inject = ["storage"]

  constructor(ctx, config) {
    super(ctx, "fakeRelational")
    this.schema = config.schema
    this.rows = new Map(Object.keys(this.schema.tables).map((name) => [name, new Map()]))
  }

  [Service.init]() {
    this.ctx.storage.register("relational", "main", this)
  }

  async execute(operation) {
    const table = this.rows.get(operation.table)
    const primary = this.schema.tables[operation.table].primaryKey
    switch (operation.type) {
      case "insert": {
        const row = structuredClone(operation.value)
        if (table.has(row[primary]) || violatesUniqueIndex(this.schema, operation.table, table, row, null)) {
          throw new Error("duplicate key")
        }
        table.set(row[primary], row)
        return { row: structuredClone(row) }
      }
      case "insertMany": {
        const rows = []
        for (const value of operation.values) {
          const row = structuredClone(value)
          if (table.has(row[primary]) || violatesUniqueIndex(this.schema, operation.table, table, row, null)) {
            throw new Error("duplicate key")
          }
          table.set(row[primary], row)
          rows.push(structuredClone(row))
        }
        return { rows }
      }
      case "upsert": {
        const row = structuredClone(operation.value)
        const inserted = !table.has(row[primary])
        if (violatesUniqueIndex(this.schema, operation.table, table, row, row[primary])) {
          throw new Error("duplicate key")
        }
        table.set(row[primary], row)
        return { row: structuredClone(row), inserted }
      }
      case "get": {
        const row = table.get(operation.key)
        return { row: row === undefined ? undefined : structuredClone(row) }
      }
      case "find": {
        const rows = [...table.values()].filter(
          (row) => operation.where === undefined || matches(row, operation.where),
        )
        for (const order of [...(operation.orderBy ?? [])].reverse()) {
          rows.sort(
            (left, right) =>
              compare(left[order.field], right[order.field]) * (order.direction === "desc" ? -1 : 1),
          )
        }
        const start = operation.offset ?? 0
        const end = operation.limit === undefined ? rows.length : start + operation.limit
        return { rows: structuredClone(rows.slice(start, end)) }
      }
      case "count": {
        const rows = [...table.values()].filter(
          (row) => operation.where === undefined || matches(row, operation.where),
        )
        return { count: rows.length }
      }
      case "update": {
        let affectedRows = 0
        for (const row of table.values()) {
          if (operation.where !== undefined && !matches(row, operation.where)) {
            continue
          }
          Object.assign(row, structuredClone(operation.patch))
          affectedRows += 1
        }
        return { affectedRows }
      }
      case "delete": {
        let affectedRows = 0
        for (const [key, row] of [...table]) {
          if (operation.where !== undefined && !matches(row, operation.where)) {
            continue
          }
          table.delete(key)
          affectedRows += 1
        }
        return { affectedRows }
      }
      default:
        throw new Error(`fake relational 不支持 ${operation.type}`)
    }
  }
}

/** 假 memoryDaily：记录 runDaily 调用，返回递增 batchId。 */
export class FakeMemoryDaily extends Service {
  constructor(ctx) {
    super(ctx, "memoryDaily")
    this.calls = []
  }

  async runDaily(scope) {
    this.calls.push(scope)
    return { batchId: `batch-${this.calls.length}` }
  }
}

/** 假 memoryFast：`pending` 可控，`countBySpace` 直接返回它。 */
export class FakeMemoryFast extends Service {
  constructor(ctx, config = {}) {
    super(ctx, "memoryFast")
    this.pending = config.pending ?? 0
  }

  async countBySpace() {
    return { total: this.pending, pending: this.pending, consumed: 0 }
  }
}
