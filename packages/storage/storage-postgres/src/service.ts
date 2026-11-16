import { Service, type Context } from "cordis"
import "toy-storage"
import type { StorageRegistration } from "toy-storage"
import type {
  RelationalAdapter,
  RelationalBatchOptions,
  RelationalCapabilities,
  RelationalExecutionOptions,
  RelationalExecutor,
  RelationalOperation,
  RelationalResultOf,
  RelationalResultsOf,
  RelationalSchemaDefinition,
  RelationalTransactionOptions,
} from "toy-storage-relational"
import { PostgresRelationalAdapter } from "./adapter.js"
import type { PostgresStorageConfig } from "./config.js"

/**
 * 一个命名 PostgreSQL 实例对应一个 Cordis 类插件。
 * 完成连接初始化后，插件自身作为 RelationalAdapter 注册到 ctx.storage。
 */
export class PostgresStorage extends Service implements RelationalAdapter {
  static inject = ["storage", "storageRelational"]

  readonly schema: RelationalSchemaDefinition
  readonly capabilities: RelationalCapabilities
  private readonly adapter: PostgresRelationalAdapter
  private readonly sourceName: string
  private unregister: StorageRegistration | undefined

  constructor(ctx: Context, config: PostgresStorageConfig) {
    // 动态服务键允许同一个插件类以不同 name 加载多个连接实例。
    super(ctx, `storagePostgres.${config.name}`)
    this.sourceName = config.name
    this.schema = ctx.storageRelational.defineSchema(config.schema)
    this.adapter = new PostgresRelationalAdapter(
      config,
      this.schema,
      (operation) => ctx.storageRelational.assertOperation(this.schema, operation),
      config.pool,
      (error) => ctx.logger.warn(`PostgreSQL '${config.name}' 的空闲连接异常：${String(error)}`),
    )
    this.capabilities = this.adapter.capabilities
    ctx.effect(() => () => this.close(), "storage-postgres.close")
  }

  /** 连接成功并按配置初始化表结构后，才向通用注册中心暴露实例。 */
  async [Service.init](): Promise<void> {
    await this.adapter.initialize()
    this.unregister = this.ctx.storage.register("relational", this.sourceName, this)
  }

  /** @inheritdoc */
  execute<O extends RelationalOperation>(
    operation: O,
    options?: RelationalExecutionOptions,
  ): Promise<RelationalResultOf<O>> {
    return this.adapter.execute(operation, options)
  }

  /** @inheritdoc */
  executeBatch<const Operations extends readonly RelationalOperation[]>(
    operations: Operations,
    options?: RelationalBatchOptions,
  ): Promise<RelationalResultsOf<Operations>> {
    return this.adapter.executeBatch(operations, options)
  }

  /** @inheritdoc */
  transaction<T>(
    callback: (transaction: RelationalExecutor) => Promise<T>,
    options?: RelationalTransactionOptions,
  ): Promise<T> {
    return this.adapter.transaction(callback, options)
  }

  /** @inheritdoc */
  close(): Promise<void> {
    this.unregister?.()
    this.unregister = undefined
    return this.adapter.close()
  }
}

export default PostgresStorage
