import type { RelationalOperation } from "./operation.js"
import type { RelationalResultOf, RelationalResultsOf } from "./result.js"
import type { RelationalSchemaDefinition } from "./schema.js"

/** 单次关系型操作的取消和超时配置。 */
export interface RelationalExecutionOptions {
  /** 调用方取消信号；adapter 应尽快终止尚未完成的数据库工作。 */
  readonly signal?: AbortSignal
  /** 本次操作允许执行的最大毫秒数。 */
  readonly timeoutMs?: number
}

/** 批量操作配置。 */
export interface RelationalBatchOptions extends RelationalExecutionOptions {
  /** true 表示整个批次必须在同一事务中全部成功或全部回滚。 */
  readonly atomic?: boolean
}

/** 跨数据库统一使用的事务隔离级别。 */
export type RelationalIsolationLevel =
  "read-uncommitted" | "read-committed" | "repeatable-read" | "serializable"

/** 开启事务时使用的行为配置。 */
export interface RelationalTransactionOptions extends RelationalExecutionOptions {
  /** 期望的事务隔离级别；具体 adapter 负责映射到数据库语法。 */
  readonly isolation?: RelationalIsolationLevel
  /** true 表示事务内禁止写入。 */
  readonly readOnly?: boolean
}

/** adapter 在运行时公开的能力与批量限制。 */
export interface RelationalCapabilities {
  /** 是否支持事务回调。 */
  readonly transactions: boolean
  /** 是否能保证 atomic 批次全部成功或全部回滚。 */
  readonly atomicBatch: boolean
  /** 是否能返回数据库提交后的完整行。 */
  readonly returning: boolean
  /** 单批建议或强制支持的最大操作数量。 */
  readonly maxBatchSize?: number
  /** 单条语句或单批允许的最大参数数量。 */
  readonly maxParameters?: number
}

/** adapter 与事务句柄共同实现的最小执行接口。 */
export interface RelationalExecutor {
  /**
   * 执行一条已经通过协议校验的关系型操作。
   *
   * @param operation 要执行的 CRUD 操作。
   * @param options 本次执行的取消和超时配置。
   * @returns 与操作类型一一对应的标准结果。
   */
  execute<O extends RelationalOperation>(
    operation: O,
    options?: RelationalExecutionOptions,
  ): Promise<RelationalResultOf<O>>

  /**
   * 按输入顺序执行一批操作。
   *
   * @param operations 有序操作列表；结果顺序必须与其一致。
   * @param options 批次原子性、取消和超时配置。
   * @returns 与每个输入操作逐项对应的结果元组。
   */
  executeBatch<const Operations extends readonly RelationalOperation[]>(
    operations: Operations,
    options?: RelationalBatchOptions,
  ): Promise<RelationalResultsOf<Operations>>
}

/** 数据库 adapter 的统一边界；连接配置和 SQL 编译由具体实现负责。 */
export interface RelationalAdapter extends RelationalExecutor {
  /** 本 adapter 接受的逻辑 Schema。 */
  readonly schema: RelationalSchemaDefinition
  /** 上层调度和降级逻辑可以依赖的能力快照。 */
  readonly capabilities: RelationalCapabilities

  /**
   * 在单个数据库事务中运行回调；回调抛错时必须回滚。
   *
   * @param callback 使用事务专属 executor 执行业务操作的回调。
   * @param options 隔离级别、只读、取消和超时配置。
   * @returns 回调成功完成后的返回值。
   */
  transaction<T>(
    callback: (transaction: RelationalExecutor) => Promise<T>,
    options?: RelationalTransactionOptions,
  ): Promise<T>

  /**
   * 停止接受新操作并释放连接等底层资源。
   *
   * @returns adapter 完全关闭后完成的 Promise；重复调用应保持幂等。
   */
  close(): Promise<void>
}
