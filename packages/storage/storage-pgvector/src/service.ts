import { Service, type Context } from "cordis"
import type { StorageRegistration } from "toy-storage"
import type {
  VectorAdapter,
  VectorExecutionOptions,
  VectorExecutor,
  VectorOperation,
  VectorResultOf,
  VectorSchemaDefinition,
  VectorTransactionOptions,
} from "toy-storage-vector"
import { PgvectorAdapter } from "./adapter.js"
import type { PgvectorStorageConfig } from "./config.js"

/** 命名 pgvector Cordis 插件，管理向量数据源在 ctx.storage 中的注册和卸载。 */
export class PgvectorStorage extends Service implements VectorAdapter {
  static inject = ["storage", "storageVector"]

  readonly schema: VectorSchemaDefinition
  private readonly adapter: PgvectorAdapter
  private readonly sourceName: string
  private unregister?: StorageRegistration

  constructor(ctx: Context, config: PgvectorStorageConfig) {
    super(ctx, `storagePgvector.${config.name}`)
    this.sourceName = config.name
    this.schema = ctx.storageVector.defineSchema(config.schema)
    this.adapter = new PgvectorAdapter(
      config,
      (operation) => {
        ctx.storageVector.assertOperation(this.schema, operation)
        return ctx.storageVector.requireCollection(this.schema, operation.collection)
      },
      (error) => ctx.logger.warn(`pgvector '${config.name}' 的空闲连接异常：${String(error)}`),
    )
    ctx.effect(() => () => this.close(), "storage-pgvector.close")
  }

  /** 扩展、集合和连接均就绪后注册实例，失败时关闭本实例的连接池。 */
  async [Service.init](): Promise<void> {
    try {
      await this.adapter.initialize()
      this.unregister = this.ctx.storage.register("vector", this.sourceName, this)
    } catch (error) {
      await this.close().catch((closeError: unknown) => {
        this.ctx.logger.warn(`关闭 pgvector '${this.sourceName}' 失败：${String(closeError)}`)
      })
      throw error
    }
  }

  /** @inheritdoc */
  execute<O extends VectorOperation>(
    operation: O,
    options?: VectorExecutionOptions,
  ): Promise<VectorResultOf<O>> {
    return this.adapter.execute(operation, options)
  }

  /** @inheritdoc */
  transaction<T>(
    callback: (transaction: VectorExecutor) => Promise<T>,
    options?: VectorTransactionOptions,
  ): Promise<T> {
    return this.adapter.transaction(callback, options)
  }

  /** 先撤销注册，再关闭连接池。重复调用返回同一次关闭的结果。 */
  close(): Promise<void> {
    this.unregister?.()
    delete this.unregister
    return this.adapter.close()
  }
}

export default PgvectorStorage
