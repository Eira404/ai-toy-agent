import type { VectorOperation } from "./operation.js"
import type { VectorResultOf } from "./result.js"
import type { VectorSchemaDefinition } from "./schema.js"

/** 单次向量操作的取消和超时配置。 */
export interface VectorExecutionOptions {
  /** 调用方取消信号，adapter 应尽快终止尚未完成的工作。 */
  readonly signal?: AbortSignal
  /** 允许执行的最大毫秒数，必须是正安全整数。 */
  readonly timeoutMs?: number
}

/** 向量事务的隔离级别。 */
export type VectorIsolationLevel =
  "read-uncommitted" | "read-committed" | "repeatable-read" | "serializable"

/** 开启向量事务时使用的配置。 */
export interface VectorTransactionOptions extends VectorExecutionOptions {
  /** 期望的事务隔离级别，由 adapter 映射到底层。 */
  readonly isolation?: VectorIsolationLevel
  /** true 表示事务内禁止写入。 */
  readonly readOnly?: boolean
}

/** 独立执行与事务执行共用的操作接口。 */
export interface VectorExecutor {
  /**
   * 校验并执行一个向量操作。检索先应用 where，再按距离和 ID 取最多 limit 条结果。
   *
   * @param operation 一个写入、按 ID 查询、删除或向量检索操作。
   * @param options 可选的取消信号和超时。
   * @returns 对应该操作的结果。独立写入在确认提交后返回，事务中的结果随外层事务提交。
   * @throws {VectorError} 校验失败、执行失败或写入提交状态无法确认时抛出。
   */
  execute<O extends VectorOperation>(
    operation: O,
    options?: VectorExecutionOptions,
  ): Promise<VectorResultOf<O>>
}

/** 向量存储实例的协议，具体 adapter 负责数据读写和底层资源。 */
export interface VectorAdapter extends VectorExecutor {
  /** 此实例用于校验每次操作的逻辑 Schema。 */
  readonly schema: VectorSchemaDefinition

  /**
   * 可选的单数据源事务。回调或其中的操作失败时回滚，执行器只在回调期间可用。
   *
   * @param callback 使用事务专属执行器执行向量操作的回调。
   * @param options 隔离级别、只读、取消和超时配置。
   * @returns 事务确认提交后的回调结果。
   */
  transaction?<T>(
    callback: (transaction: VectorExecutor) => Promise<T>,
    options?: VectorTransactionOptions,
  ): Promise<T>

  /**
   * 停止接受新操作并释放连接等底层资源。重复调用应保持幂等。
   *
   * @returns 底层资源关闭后完成的 Promise。
   */
  close(): Promise<void>
}
