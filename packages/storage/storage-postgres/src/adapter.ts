import { Pool, type PoolClient, type PoolConfig, type QueryResult } from "pg"
import {
  RelationalError,
  type RelationalAdapter,
  type RelationalBatchOptions,
  type RelationalCapabilities,
  type RelationalExecutionOptions,
  type RelationalExecutor,
  type RelationalOperation,
  type RelationalRecord,
  type RelationalResult,
  type RelationalResultOf,
  type RelationalResultsOf,
  type RelationalSchemaDefinition,
  type RelationalTransactionOptions,
} from "toy-storage-relational"
import type { PostgresStorageConfig } from "./config.js"
import { compileOperation } from "./compiler.js"
import { normalizePostgresError } from "./errors.js"
import { createMissingSchema } from "./schema.js"
import { quoteIdentifier } from "./sql.js"

/** 连接池和事务共用的最小查询能力。 */
type Queryable = Pick<PoolClient, "query">

/** 基于 PostgreSQL 的完整关系型 adapter；连接池归此实例所有。 */
export class PostgresRelationalAdapter implements RelationalAdapter {
  readonly capabilities: RelationalCapabilities = Object.freeze({
    transactions: true,
    atomicBatch: true,
    returning: true,
    maxParameters: 65_535,
  })

  readonly schema: RelationalSchemaDefinition
  private readonly pool: Pool
  private readonly schemaName: string
  private readonly createMissing: boolean
  private readonly validateOperation: (operation: RelationalOperation) => void
  private closed = false
  private closing?: Promise<void>

  /**
   * @param config 命名数据源、连接参数及逻辑 Schema。
   * @param schema 已通过关系型协议插件校验的 Schema。
   * @param validateOperation 关系型协议插件提供的操作校验方法。
   * @param poolOverride 测试时注入的连接池；生产环境由 adapter 创建。
   * @param onPoolError 空闲连接异常的诊断回调。
   */
  constructor(
    config: PostgresStorageConfig,
    schema: RelationalSchemaDefinition,
    validateOperation: (operation: RelationalOperation) => void,
    poolOverride?: Pool,
    onPoolError?: (error: Error) => void,
  ) {
    if (!config.connectionString.trim()) {
      throw new RelationalError("connection-failed", "PostgreSQL connectionString 不能为空")
    }
    this.schema = schema
    this.validateOperation = validateOperation
    this.schemaName = config.schemaName ?? "public"
    quoteIdentifier(this.schemaName)
    this.createMissing = config.createMissing ?? false
    const poolConfig: PoolConfig = {
      connectionString: config.connectionString,
      max: config.maxConnections ?? 10,
      connectionTimeoutMillis: config.connectionTimeoutMs ?? 5_000,
      idleTimeoutMillis: config.idleTimeoutMs ?? 30_000,
      options: "-c timezone=UTC -c synchronous_commit=on",
    }
    this.pool = poolOverride ?? new Pool(poolConfig)
    // 空闲客户端的错误也必须被消费，否则 Node 会把它当成未处理的 EventEmitter 错误。
    this.pool.on("error", (error) => onPoolError?.(error))
  }

  /**
   * 建立真实连接并可选创建缺失结构；完成后才可向注册中心暴露 adapter。
   *
   * @returns 数据源就绪后完成的 Promise。
   */
  async initialize(): Promise<void> {
    this.assertOpen()
    const client = await this.pool.connect().catch((error: unknown) => {
      throw normalizePostgresError(error)
    })
    try {
      if (this.createMissing) {
        await client.query("BEGIN")
        let committing = false
        try {
          await createMissingSchema(client, this.schemaName, this.schema)
          committing = true
          await client.query("COMMIT")
        } catch (error) {
          if (committing) {
            throw new RelationalError(
              "unknown-commit-state",
              "PostgreSQL Schema 初始化结果无法确认",
              {
                cause: error,
              },
            )
          }
          await client.query("ROLLBACK").catch(() => undefined)
          throw error
        }
      } else {
        await client.query("SELECT 1")
      }
    } catch (error) {
      throw normalizePostgresError(error)
    } finally {
      client.release()
    }
  }

  /**
   * @param operation 要执行的关系型操作。
   * @param options 取消信号和超时。
   * @returns 与操作类型对应的统一结果。
   */
  async execute<O extends RelationalOperation>(
    operation: O,
    options: RelationalExecutionOptions = {},
  ): Promise<RelationalResultOf<O>> {
    return this.transaction((executor) => executor.execute(operation, options), options)
  }

  /**
   * @param operations 按顺序执行的操作列表。
   * @param options atomic 为 true 时整个批次使用同一事务。
   * @returns 按输入顺序排列的结果元组。
   */
  async executeBatch<const Operations extends readonly RelationalOperation[]>(
    operations: Operations,
    options: RelationalBatchOptions = {},
  ): Promise<RelationalResultsOf<Operations>> {
    if (options.atomic) {
      return this.transaction((executor) => executor.executeBatch(operations, options), options)
    }
    const results: RelationalResult[] = []
    for (const operation of operations) {
      results.push(await this.execute(operation, options))
    }
    return results as RelationalResultsOf<Operations>
  }

  /**
   * 在同一个 PostgreSQL client 上执行回调，成功则提交，失败则回滚。
   *
   * @param callback 只在事务期间有效的执行回调。
   * @param options 隔离级别、只读、超时和取消信号。
   * @returns 事务提交成功后的回调结果。
   */
  async transaction<T>(
    callback: (transaction: RelationalExecutor) => Promise<T>,
    options: RelationalTransactionOptions = {},
  ): Promise<T> {
    this.assertOpen()
    assertNotAborted(options.signal)
    const client = await this.pool.connect().catch((error: unknown) => {
      throw normalizePostgresError(error)
    })
    let committing = false
    let callbackFailed = false
    try {
      await client.query("BEGIN")
      if (options.isolation !== undefined || options.readOnly !== undefined) {
        const level = isolationSql(options.isolation)
        await client.query(
          `SET TRANSACTION ISOLATION LEVEL ${level}${options.readOnly ? ", READ ONLY" : ""}`,
        )
      }
      if (options.timeoutMs !== undefined) {
        assertTimeout(options.timeoutMs)
        await client.query("SELECT set_config('statement_timeout', $1, true)", [
          String(options.timeoutMs),
        ])
      }
      const transaction = this.transactionExecutor(client)
      let value: T
      try {
        value = await callback(transaction.executor)
      } catch (error) {
        callbackFailed = true
        throw error
      } finally {
        transaction.close()
      }
      assertNotAborted(options.signal)
      committing = true
      await client.query("COMMIT")
      committing = false
      return value
    } catch (error) {
      if (committing) {
        // 连接在 COMMIT 阶段断开时，数据库可能已提交，不能自动重试。
        throw new RelationalError("unknown-commit-state", "PostgreSQL 提交结果无法确认", {
          cause: error,
        })
      }
      await client.query("ROLLBACK").catch(() => undefined)
      if (callbackFailed) {
        // 业务回调的异常不是数据库故障，保留调用方原始错误。
        throw error
      }
      throw normalizePostgresError(error)
    } finally {
      client.release(committing)
    }
  }

  /** @returns 连接池完全关闭后完成的 Promise；可重复调用。 */
  close(): Promise<void> {
    this.closing ??= (async () => {
      this.closed = true
      await this.pool.end()
    })()
    return this.closing
  }

  private transactionExecutor(client: PoolClient): {
    executor: RelationalExecutor
    close: () => void
  } {
    let active = true
    const execute = async <O extends RelationalOperation>(
      operation: O,
      options: RelationalExecutionOptions = {},
    ): Promise<RelationalResultOf<O>> => {
      if (!active) {
        throw new RelationalError("closed", "事务执行句柄已失效")
      }
      assertNotAborted(options.signal)
      this.validateOperation(operation)
      const table = this.schema.tables[operation.table]
      if (table === undefined) {
        throw new RelationalError("table-not-found", `表 '${operation.table}' 未声明`)
      }
      if (options.timeoutMs !== undefined) {
        assertTimeout(options.timeoutMs)
        await client.query("SELECT set_config('statement_timeout', $1, true)", [
          String(options.timeoutMs),
        ])
      }
      if (
        operation.type === "insertMany" &&
        (operation.values.some((value) => !(table.primaryKey in value)) ||
          ["datetime", "json"].includes(table.columns[table.primaryKey]!.type))
      ) {
        // 生成型主键和可能被 PostgreSQL 规范化的主键无法可靠匹配批量 RETURNING 行。
        const rows: RelationalRecord[] = []
        for (const value of operation.values) {
          assertNotAborted(options.signal)
          const compiled = compileOperation(this.schema, this.schemaName, {
            type: "insert",
            table: operation.table,
            value,
          })
          try {
            const result = await client.query(compiled.text, [...compiled.values])
            const returned = result.rows[0] as Record<string, unknown> | undefined
            rows.push(requireRow(returned && normalizeRow(returned, table.columns)))
          } catch (error) {
            throw normalizePostgresError(error)
          }
        }
        assertNotAborted(options.signal)
        return { rows } as unknown as RelationalResultOf<O>
      }
      const compiled = compileOperation(this.schema, this.schemaName, operation)
      try {
        const result = await (client as Queryable).query(compiled.text, [...compiled.values])
        assertNotAborted(options.signal)
        return mapResult(operation, result, this.schema) as RelationalResultOf<O>
      } catch (error) {
        throw normalizePostgresError(error)
      }
    }
    const executor: RelationalExecutor = {
      execute,
      executeBatch: async <Operations extends readonly RelationalOperation[]>(
        operations: Operations,
        _options?: RelationalBatchOptions,
      ): Promise<RelationalResultsOf<Operations>> => {
        const results: RelationalResult[] = []
        for (const operation of operations) {
          results.push(await execute(operation, _options))
        }
        return results as RelationalResultsOf<Operations>
      },
    }
    return {
      executor,
      close: () => {
        active = false
      },
    }
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new RelationalError("closed", "PostgreSQL adapter 已关闭")
    }
  }
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new RelationalError("cancelled", "PostgreSQL 操作已取消")
  }
}

function assertTimeout(timeoutMs: number): void {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new RelationalError("invalid-operation", "timeoutMs 必须是正安全整数")
  }
}

function isolationSql(value?: RelationalTransactionOptions["isolation"]): string {
  switch (value) {
    case "read-uncommitted":
      return "READ UNCOMMITTED"
    case "repeatable-read":
      return "REPEATABLE READ"
    case "serializable":
      return "SERIALIZABLE"
    default:
      return "READ COMMITTED"
  }
}

function mapResult(
  operation: RelationalOperation,
  result: QueryResult,
  schema: RelationalSchemaDefinition,
): RelationalResult {
  const table = schema.tables[operation.table]
  if (table === undefined) {
    throw new RelationalError("table-not-found", `表 '${operation.table}' 未声明`)
  }
  const rows = result.rows.map((row: Record<string, unknown>) => normalizeRow(row, table.columns))
  switch (operation.type) {
    case "get":
      return { row: rows[0] }
    case "find":
      return { rows }
    case "count": {
      const count = Number((result.rows[0] as { count?: string } | undefined)?.count)
      if (!Number.isSafeInteger(count)) {
        throw new RelationalError("invalid-value", "数据库计数超过 JavaScript 安全整数范围")
      }
      return { count }
    }
    case "insert":
      return { row: requireRow(rows[0]) }
    case "insertMany":
      return { rows: orderInsertedRows(operation.values, rows, table.primaryKey) }
    case "upsert": {
      const inserted = (result.rows[0] as { __toy_storage_inserted?: boolean } | undefined)
        ?.__toy_storage_inserted
      return { row: requireRow(rows[0]), inserted: inserted === true }
    }
    case "update":
    case "delete":
      return { affectedRows: result.rowCount ?? 0 }
  }
}

/** 按调用方提供的主键恢复批量插入结果的输入顺序。 */
function orderInsertedRows(
  values: readonly RelationalRecord[],
  rows: readonly RelationalRecord[],
  primaryKey: string,
): readonly RelationalRecord[] {
  const byKey = new Map<string, RelationalRecord>()
  for (const row of rows) {
    byKey.set(JSON.stringify(row[primaryKey]), row)
  }
  return values.map((value) => {
    const row = byKey.get(JSON.stringify(value[primaryKey]))
    if (row === undefined) {
      throw new RelationalError("invalid-value", "数据库批量插入结果缺少对应主键")
    }
    return row
  })
}

function normalizeRow(
  row: Record<string, unknown>,
  columns: RelationalSchemaDefinition["tables"][string]["columns"],
): RelationalRecord {
  const output: Record<string, import("toy-storage-relational").JsonValue> = Object.create(null)
  for (const [field, column] of Object.entries(columns)) {
    const value = row[field]
    if (value === undefined) {
      continue
    }
    if (value instanceof Date) {
      output[field] = value.toISOString()
    } else if (column.type === "integer" && typeof value === "string") {
      const number = Number(value)
      if (!Number.isSafeInteger(number)) {
        throw new RelationalError("invalid-value", `字段 '${field}' 超过安全整数范围`)
      }
      output[field] = number
    } else {
      output[field] = value as import("toy-storage-relational").JsonValue
    }
  }
  return output
}

function requireRow(row: RelationalRecord | undefined): RelationalRecord {
  if (row === undefined) {
    throw new RelationalError("invalid-value", "数据库未返回预期的写入记录")
  }
  return row
}
