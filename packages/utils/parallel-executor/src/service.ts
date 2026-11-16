import { Service, type Context } from "cordis"
import { Executor } from "./executor.js"
import type {
  MapOptions,
  MapTaskContext,
  ParallelExecutorConfig,
  ParallelStats,
  RunOptions,
  TaskContext,
  TaskPoolConfig,
  TaskResult,
  WaitForIdleOptions,
} from "./types.js"

declare module "cordis" {
  interface Context {
    parallelExecutor: ParallelExecutor
  }
}

/** Cordis 命名任务池。通过 ctx.parallelExecutor 调用，不绑定模型或存储。 */
export class ParallelExecutor extends Service {
  private readonly executor: Executor

  constructor(ctx: Context, config: ParallelExecutorConfig = {}) {
    super(ctx, "parallelExecutor")
    this.executor = new Executor(config)
    ctx.effect(() => () => this.executor.stop(), "parallel.stop")
  }

  /** 同名完整覆盖；保留运行中的任务、FIFO 队列与计数。 */
  registerPool(name: string, config: TaskPoolConfig): void {
    this.executor.registerPool(name, config)
  }

  hasPool(name: string): boolean {
    return this.executor.hasPool(name)
  }

  /** 提交完整任务；回调退出前一直占用池名额。 */
  run<R>(task: (context: TaskContext) => R | PromiseLike<R>, options: RunOptions): Promise<R> {
    return this.executor.run(task, options)
  }

  /** 有序严格批次：首次失败后停止派发、取消同批任务并等待收尾。 */
  map<T, R>(
    items: readonly T[],
    worker: (item: T, context: MapTaskContext) => R | PromiseLike<R>,
    options: MapOptions,
  ): Promise<R[]> {
    return this.executor.map(items, worker, options)
  }

  /** 有序逐项结果；普通任务失败不阻止后续项目。 */
  mapSettled<T, R>(
    items: readonly T[],
    worker: (item: T, context: MapTaskContext) => R | PromiseLike<R>,
    options: MapOptions,
  ): Promise<TaskResult<R>[]> {
    return this.executor.mapSettled(items, worker, options)
  }

  stats(pool?: string): ParallelStats {
    return this.executor.stats(pool)
  }

  /** 取消本次等待不影响池任务；先停止任务生产方再用于停机排空。 */
  waitForIdle(options: WaitForIdleOptions = {}): Promise<void> {
    return this.executor.waitForIdle(options)
  }
}
