import { Pool, type PoolClient } from "pg"
import {
  VectorError,
  type VectorAdapter,
  type VectorCollectionDefinition,
  type VectorExecutionOptions,
  type VectorExecutor,
  type VectorIsolationLevel,
  type VectorOperation,
  type VectorResultOf,
  type VectorSchemaDefinition,
  type VectorTransactionOptions,
} from "toy-storage-vector"
import { compileStatements, mapResult, type ResultRow } from "./compiler.js"
import type { PgvectorStorageConfig } from "./config.js"
import { normalizePgError } from "./errors.js"
import { assertPhysicalSchema, initializeCollections, requireVectorExtension } from "./schema.js"

const isolationLevels: Record<VectorIsolationLevel, string> = {
  "read-uncommitted": "READ UNCOMMITTED",
  "read-committed": "READ COMMITTED",
  "repeatable-read": "REPEATABLE READ",
  serializable: "SERIALIZABLE",
}

/** 管理一个 pgvector 数据源的连接池、初始化与向量操作。 */
export class PgvectorAdapter implements VectorAdapter {
  readonly schema: VectorSchemaDefinition
  private readonly pool: Pool
  private readonly schemaName: string
  private readonly createMissing: boolean
  private extensionSchema?: string
  private closing?: Promise<void>

  /**
   * @param config 连接选项和已由协议服务校验的逻辑 Schema。
   * @param validateOperation 校验操作并返回本次使用的集合定义。
   * @param onPoolError 处理空闲连接异常的诊断回调。
   */
  constructor(
    config: PgvectorStorageConfig,
    private readonly validateOperation: (operation: VectorOperation) => VectorCollectionDefinition,
    onPoolError: (error: Error) => void,
  ) {
    if (!config.connectionString.trim()) {
      throw new VectorError("invalid-operation", "PostgreSQL connectionString 不能为空")
    }
    this.schema = config.schema
    this.schemaName = config.schemaName ?? "public"
    this.createMissing = config.createMissing ?? false
    assertPhysicalSchema(this.schemaName, this.schema)
    this.pool =
      config.pool ??
      new Pool({
        connectionString: config.connectionString,
        max: config.maxConnections ?? 10,
        connectionTimeoutMillis: config.connectionTimeoutMs ?? 5_000,
        idleTimeoutMillis: config.idleTimeoutMs ?? 30_000,
        options: "-c synchronous_commit=on",
      })
    // pg 会把空闲连接上的异常发给池。绑定监听器，使故障可以记录并由池补充连接。
    this.pool.on("error", onPoolError)
  }

  /** 连接数据库，确认扩展与全部集合就绪，再允许执行向量操作。 */
  async initialize(): Promise<void> {
    const extension = await this.runTransaction(this.createMissing, {}, async (client) => {
      const extension = await requireVectorExtension(client)
      await initializeCollections(
        client,
        this.schemaName,
        this.schema,
        extension,
        this.createMissing,
      )
      return extension
    }).catch((error: unknown) => {
      throw normalizePgError(error)
    })
    this.assertOpen()
    this.extensionSchema = extension.schema
  }

  /** @inheritdoc */
  async execute<O extends VectorOperation>(
    operation: O,
    options: VectorExecutionOptions = {},
  ): Promise<VectorResultOf<O>> {
    const execute = this.prepareExecution(operation, options.signal)
    const writes = operation.type !== "get" && operation.type !== "search"
    return this.runTransaction(writes, options, execute)
  }

  /** @inheritdoc */
  async transaction<T>(
    callback: (transaction: VectorExecutor) => Promise<T>,
    options: VectorTransactionOptions = {},
  ): Promise<T> {
    this.requireExtensionSchema()
    return this.runTransaction(!options.readOnly, options, async (client) => {
      let active = true
      let pending = Promise.resolve()
      let failure: { error: unknown } | undefined
      const execute: VectorExecutor["execute"] = (operation, executionOptions = {}) => {
        if (!active) {
          return Promise.reject(new VectorError("closed", "向量事务执行器已失效"))
        }
        // 同一连接上的操作串行执行。回调提前返回或失败时也要等待已登记的操作。
        const result = pending.then(() => {
          if (failure !== undefined) {
            throw failure.error
          }
          const operationSignal = executionOptions.signal
          const signal =
            options.signal && operationSignal
              ? AbortSignal.any([options.signal, operationSignal])
              : (options.signal ?? operationSignal)
          return this.prepareExecution(operation, signal)(client, executionOptions.timeoutMs)
        })
        pending = result.then(
          () => undefined,
          (error: unknown) => {
            failure ??= { error }
          },
        )
        return result
      }
      try {
        const value = await callback({ execute })
        active = false
        await pending
        if (failure !== undefined) {
          throw failure.error
        }
        return value
      } finally {
        active = false
        await pending
      }
    })
  }

  /** @inheritdoc */
  close(): Promise<void> {
    this.closing ??= this.pool.end()
    return this.closing
  }

  private prepareExecution<O extends VectorOperation>(
    operation: O,
    signal?: AbortSignal,
  ): (client: PoolClient, timeoutMs?: number) => Promise<VectorResultOf<O>> {
    const extensionSchema = this.requireExtensionSchema()
    const collection = this.validateOperation(operation)
    const fields = Object.keys(collection.filterFields ?? {})
    const statements = compileStatements(this.schemaName, extensionSchema, fields, operation)

    return async (client, timeoutMs) => {
      assertNotAborted(signal)
      assertTimeout(timeoutMs)
      try {
        let previousTimeout: string | undefined
        if (timeoutMs !== undefined) {
          const current = await client.query<{ statement_timeout: string }>(
            "SHOW statement_timeout",
          )
          previousTimeout = current.rows[0]?.statement_timeout
          await setStatementTimeout(client, String(timeoutMs))
        }
        let rowCount = 0
        let rows: ResultRow[] = []
        for (const { text, values } of statements) {
          assertNotAborted(signal)
          const result = await client.query<ResultRow>(text, values)
          rowCount += result.rowCount ?? 0
          rows = result.rows
        }
        assertNotAborted(signal)
        if (previousTimeout !== undefined) {
          await setStatementTimeout(client, previousTimeout)
        }
        return mapResult(operation, fields, { rowCount, rows }) as VectorResultOf<O>
      } catch (error) {
        throw normalizePgError(error)
      }
    }
  }

  /**
   * 同一连接负责 BEGIN、语句和 COMMIT。提交前失败可回滚，写入在提交阶段失联时
   * 保留未知状态，避免把可能已落库的操作交给队列自动重试。
   */
  private async runTransaction<T>(
    writes: boolean,
    { signal, timeoutMs, isolation }: VectorTransactionOptions,
    run: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    this.assertOpen()
    assertNotAborted(signal)
    assertTimeout(timeoutMs)
    if (isolation !== undefined && !Object.hasOwn(isolationLevels, isolation)) {
      throw new VectorError("invalid-operation", "不支持的向量事务隔离级别")
    }
    const client = await this.pool.connect().catch((error: unknown) => {
      throw normalizePgError(error, true)
    })
    let active = false
    let committing = false
    let discard = false
    let running = false
    try {
      assertNotAborted(signal)
      await client.query(writes ? "BEGIN" : "BEGIN READ ONLY")
      active = true
      if (isolation !== undefined) {
        await client.query(`SET TRANSACTION ISOLATION LEVEL ${isolationLevels[isolation]}`)
      }
      if (timeoutMs !== undefined) {
        await setStatementTimeout(client, String(timeoutMs))
      }
      assertNotAborted(signal)
      running = true
      const value = await run(client)
      running = false
      assertNotAborted(signal)
      committing = true
      const result = await client.query("COMMIT")
      committing = false
      active = false
      if (result.command !== "COMMIT") {
        throw new VectorError("invalid-operation", "pgvector 事务未提交")
      }
      return value
    } catch (error) {
      if (committing) {
        discard = true
        if (writes) {
          throw new VectorError("unknown-commit-state", "pgvector 提交结果无法确认", {
            cause: error,
          })
        }
      } else if (active) {
        // 回滚失败时丢弃连接，防止后续操作复用状态不确定的事务。
        await client.query("ROLLBACK").catch(() => {
          discard = true
        })
      } else {
        discard = !(error instanceof VectorError)
      }
      throw running ? error : normalizePgError(error)
    } finally {
      client.release(discard)
    }
  }

  private requireExtensionSchema(): string {
    this.assertOpen()
    if (this.extensionSchema === undefined) {
      throw new VectorError("closed", "pgvector 数据源尚未就绪")
    }
    return this.extensionSchema
  }

  private assertOpen(): void {
    if (this.closing !== undefined) {
      throw new VectorError("closed", "pgvector 数据源已关闭")
    }
  }
}

function assertTimeout(timeoutMs?: number): void {
  if (
    timeoutMs !== undefined &&
    (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647)
  ) {
    throw new VectorError("invalid-operation", "timeoutMs 必须是 1 到 2147483647 的整数")
  }
}

async function setStatementTimeout(client: PoolClient, value: string): Promise<void> {
  await client.query("SELECT pg_catalog.set_config('statement_timeout', $1, true)", [value])
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new VectorError("cancelled", "pgvector 操作已取消", { cause: signal.reason })
  }
}
