// 内存 mock：关系型、向量与 Embedding，供测试与示例复用（不连真库）。
import { Service } from "cordis"

/** 供 fast 包测试/示例使用的向量维度。 */
export const DIM = 4

/** 确定性“伪 Embedding”，把文本哈希成 DIM 维向量。 */
export function fakeVector(text) {
  const vector = new Array(DIM).fill(0)
  for (let i = 0; i < text.length; i += 1) {
    vector[i % DIM] = (vector[i % DIM] + text.charCodeAt(i)) % 10
  }
  if (vector.every((value) => value === 0)) {
    vector[0] = 1
  }
  return vector
}

/** 可注册到 `ctx.embedding` 的伪适配器。 */
export const fakeEmbeddingAdapter = {
  providerInfo: (id) => ({ id, name: "fake" }),
  embed: async (request) => ({
    vectors: request.texts.map((text) => fakeVector(text)),
    modelId: "fake-model",
    dimensions: DIM,
  }),
}

function compare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0
}

function matches(row, filter) {
  switch (filter.type) {
    case "eq":
      return row[filter.field] === filter.value
    case "ne":
      return row[filter.field] !== filter.value
    case "lte":
      return row[filter.field] <= filter.value
    case "lt":
      return row[filter.field] < filter.value
    case "in":
      return filter.values.includes(row[filter.field])
    case "isNull":
      return row[filter.field] === null || row[filter.field] === undefined
    case "and":
      return filter.conditions.every((item) => matches(row, item))
    case "or":
      return filter.conditions.some((item) => matches(row, item))
    default:
      throw new Error(`fake 不支持 filter ${filter.type}`)
  }
}

function violatesUniqueIndex(schema, tableName, table, row) {
  const indexes = schema.tables[tableName].indexes ?? []
  for (const index of indexes) {
    if (!index.unique) {
      continue
    }
    const key = index.fields.map((field) => row[field]).join("\u0000")
    for (const existing of table.values()) {
      const existingKey = index.fields.map((field) => existing[field]).join("\u0000")
      if (existingKey === key) {
        return true
      }
    }
  }
  return false
}

/** 内存关系型 adapter，实现 fast 用到的最小操作集 + 回滚式事务。 */
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
        if (table.has(row[primary]) || violatesUniqueIndex(this.schema, operation.table, table, row)) {
          throw new Error("duplicate key")
        }
        table.set(row[primary], row)
        return { row: structuredClone(row) }
      }
      case "insertMany": {
        const rows = []
        for (const value of operation.values) {
          const row = structuredClone(value)
          if (table.has(row[primary]) || violatesUniqueIndex(this.schema, operation.table, table, row)) {
            throw new Error("duplicate key")
          }
          table.set(row[primary], row)
          rows.push(structuredClone(row))
        }
        return { rows }
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
      default:
        throw new Error(`fake 不支持 ${operation.type}`)
    }
  }

  async transaction(callback) {
    const snapshot = new Map()
    for (const [name, map] of this.rows) {
      snapshot.set(name, new Map([...map].map(([key, value]) => [key, structuredClone(value)])))
    }
    try {
      return await callback({ execute: (operation) => this.execute(operation) })
    } catch (error) {
      this.rows.clear()
      for (const [name, map] of snapshot) {
        this.rows.set(name, map)
      }
      throw error
    }
  }
}

function cosineDistance(left, right) {
  let dot = 0
  let leftNorm = 0
  let rightNorm = 0
  for (let i = 0; i < left.length; i += 1) {
    dot += left[i] * right[i]
    leftNorm += left[i] * left[i]
    rightNorm += right[i] * right[i]
  }
  if (leftNorm === 0 || rightNorm === 0) {
    return 1
  }
  return 1 - dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm))
}

function matchesVectorFilter(record, filter) {
  if (filter === undefined) {
    return true
  }
  if (filter.type === "eq") {
    return record.fields[filter.field] === filter.value
  }
  if (filter.type === "and") {
    return filter.conditions.every((condition) => matchesVectorFilter(record, condition))
  }
  throw new Error(`fake vector 不支持 filter ${filter.type}`)
}

/** 内存向量 adapter，实现 upsertMany / deleteMany / search。 */
export class FakeVector extends Service {
  static inject = ["storage"]

  constructor(ctx, config) {
    super(ctx, "fakeVector")
    this.schema = config.schema
    this.records = new Map()
  }

  [Service.init]() {
    this.ctx.storage.register("vector", "main", this)
  }

  async execute(operation) {
    switch (operation.type) {
      case "upsertMany": {
        const ids = []
        for (const value of operation.values) {
          this.records.set(value.id, structuredClone(value))
          ids.push(value.id)
        }
        return { ids }
      }
      case "deleteMany": {
        let affectedRows = 0
        for (const id of operation.ids) {
          if (this.records.delete(id)) {
            affectedRows += 1
          }
        }
        return { affectedRows }
      }
      case "search": {
        const matches = []
        for (const record of this.records.values()) {
          if (!matchesVectorFilter(record, operation.where)) {
            continue
          }
          matches.push({
            id: record.id,
            fields: structuredClone(record.fields),
            distance: cosineDistance(operation.vector, record.vector),
          })
        }
        matches.sort(
          (left, right) =>
            left.distance - right.distance || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
        )
        return { matches: matches.slice(0, operation.limit) }
      }
      default:
        throw new Error(`fake vector 不支持 ${operation.type}`)
    }
  }
}
