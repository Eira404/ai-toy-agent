/**
 * 传给单个处理器的上下文，由 `run` 的输入字段和执行器注入的字段组成。
 *
 * @typeParam TContext 调用方为本工作流定义的输入类型。`upstream`、`state` 和 `signal` 由执行器提供。
 */
export type LifecycleNodeContext<TContext extends object> = Readonly<
  Omit<TContext, "upstream" | "signal" | "state">
> & {
  /** 按节点名索引当前处理器声明的直接依赖结果。无依赖时为空对象。 */
  readonly upstream: Readonly<Record<string, unknown>>
  /**
   * 本次运行共享的可变状态。所有处理器拿到同一份对象，可读写任意 key；依赖链上已完成节点的
   * 写入对后续节点可见，独立并行分支写同一 key 会产生竞态（用 `dependsOn` 声明顺序）。
   */
  readonly state: Record<string, unknown>
  /** 本次运行的取消信号。处理器可将它传给自己发起的异步操作。 */
  readonly signal: AbortSignal | undefined
}

/** 注册到一张工作流图的处理器定义。 */
export interface LifecycleProcessor<TContext extends object> {
  /** 图内唯一的节点名，也是依赖声明和结果查询使用的键。注册时会去除首尾空白。 */
  readonly name: string
  /** 直接依赖的节点名。全部成功后才执行当前节点，省略时当前节点可直接执行。 */
  readonly dependsOn?: readonly string[]
  /** 结果排序权重，默认为 0。较小值排在前面，同值按注册顺序排列。 */
  readonly order?: number

  /**
   * 执行本节点的工作，可以同步返回或等待异步操作。
   *
   * @param context 本次输入、直接依赖的结果和取消信号。
   * @returns 节点结果，可通过下游节点的 `upstream[name]` 或最终结果的 `data[name]` 读取。
   */
  process(context: LifecycleNodeContext<TContext>): unknown | Promise<unknown>
}

/** 单次 `run` 调用的执行选项。 */
export interface LifecycleRunOptions {
  /** 取消时跳过尚未开始的节点，已开始的节点可通过该信号配合退出。 */
  readonly signal?: AbortSignal
  /** 本次运行的共享状态初始值；省略时使用新的空对象。结束后在 `result.state` 返回同一份对象。 */
  readonly state?: Record<string, unknown>
}

/** 一个已成功完成的处理器及其输出。 */
export interface LifecycleItem {
  /** 注册时使用的节点名。 */
  readonly name: string
  /** 处理器返回的值。 */
  readonly data: unknown
  /** 处理器开始到完成的耗时，以毫秒计。等待上游依赖的时间在此之前。 */
  readonly durationMs: number
}

/** 整张图成功执行后的聚合结果。 */
export interface LifecycleResult {
  /** 先按 `order` 升序排列，同值按注册顺序排列。 */
  readonly items: readonly LifecycleItem[]
  /** 与 `items` 对应的结果，可通过处理器名称直接取值。 */
  readonly data: Readonly<Record<string, unknown>>
  /** 本次运行结束后的共享状态；处理器通过 `context.state` 写入的任意 key 都在这里。 */
  readonly state: Record<string, unknown>
}

/** 处理器抛错或返回拒绝的 Promise 时产生的错误，原始错误保存在 `cause`。 */
export class LifecycleProcessorError extends Error {
  /**
   * @param processorName 执行失败的处理器名称。
   * @param cause 处理器抛出的值或 Promise 拒绝原因。
   */
  constructor(
    readonly processorName: string,
    cause: unknown,
  ) {
    super(`生命周期处理器 '${processorName}' 执行失败`, { cause })
    this.name = "LifecycleProcessorError"
  }
}

/** 注册时保存的配置，供之后的运行快照使用。 */
interface Registration<TContext extends object> {
  readonly name: string
  readonly dependsOn: readonly string[]
  readonly order: number
  readonly sequence: number
  readonly process: LifecycleProcessor<TContext>["process"]
}

/** 构建拓扑顺序时使用的节点及反向依赖边。 */
interface PlanNode<TContext extends object> {
  readonly registration: Registration<TContext>
  readonly dependents: PlanNode<TContext>[]
  /** 尚未排入执行计划的直接依赖数。 */
  remaining: number
}

/**
 * 管理一个阶段的处理器并按依赖执行。为预处理、后处理等独立阶段分别创建实例。
 *
 * @typeParam TContext 该阶段的输入类型。每次 `run` 传入当前调用所需的输入。
 */
export class LifecycleGraph<TContext extends object> {
  private readonly registrations = new Map<string, Registration<TContext>>()
  private nextSequence = 0

  /**
   * 注册一个处理器。可以先注册下游，再注册它依赖的节点，整张图会在 `run` 时校验。
   *
   * @param processor 处理器名称、依赖和执行函数。可用 `order` 指定输出顺序。
   * @returns 注销本次注册的函数。可在插件卸载时调用，只影响之后发起的运行。
   * @throws {TypeError} 名称为空、依赖声明无效或 `order` 不是有限数值。
   * @throws {Error} 同名处理器已经注册。
   * @example
   * const unregister = graph.register({
   *   name: "profile",
   *   process: ({ userId }) => loadProfile(userId),
   * })
   * // 插件卸载时调用 unregister()
   */
  register(processor: LifecycleProcessor<TContext>): () => void {
    const name = processor.name.trim()
    if (name.length === 0) {
      throw new TypeError("生命周期处理器名称不能为空")
    }
    if (this.registrations.has(name)) {
      throw new Error(`生命周期处理器已注册：${name}`)
    }

    const dependsOn = (processor.dependsOn ?? []).map((dependency) => dependency.trim())
    if (dependsOn.includes("")) {
      throw new TypeError(`生命周期处理器 '${name}' 的 dependsOn 不能包含空名称`)
    }
    if (new Set(dependsOn).size !== dependsOn.length) {
      throw new TypeError(`生命周期处理器 '${name}' 的 dependsOn 不能包含重复节点`)
    }
    if (dependsOn.includes(name)) {
      throw new TypeError(`生命周期处理器 '${name}' 不能依赖自身`)
    }

    const order = processor.order ?? 0
    if (!Number.isFinite(order)) {
      throw new TypeError(`生命周期处理器 '${name}' 的 order 必须是有限数值`)
    }
    const registration: Registration<TContext> = {
      name,
      dependsOn,
      order,
      sequence: this.nextSequence++,
      process: processor.process.bind(processor),
    }
    this.registrations.set(name, registration)
    return () => {
      // 同名节点重新注册后，旧注销函数只能移除自己的注册记录。
      if (this.registrations.get(name) === registration) {
        this.registrations.delete(name)
      }
    }
  }

  /**
   * 用当前注册快照执行整张图。每个节点在直接依赖完成后即可运行，独立分支可以并行。
   *
   * @param context 本次运行的业务输入，顶层字段会传给每个处理器。
   * @param options 可传入 `signal` 和初始 `state`。取消后等待已开始的处理器退出，再以取消原因拒绝。
   * @returns 所有节点成功后的聚合结果。空图返回空列表和空数据对象。
   * @throws {Error} 图中存在缺失依赖或循环依赖，校验失败时所有节点均未执行。
   * @throws {LifecycleProcessorError} 节点执行失败。其下游会跳过，独立分支收尾后报告错误。
   * @example
   * const result = await graph.run({ userId: "u1" }, { signal })
   * const profile = result.data.profile
   */
  async run(
    context: TContext,
    { signal, state }: LifecycleRunOptions = {},
  ): Promise<LifecycleResult> {
    signal?.throwIfAborted()
    const sharedState: Record<string, unknown> = state ?? {}
    const plan = planExecution([...this.registrations.values()])
    // 每次运行各自保存任务和依赖结果，同一张图可以同时处理多份输入。
    const tasks = new Map<string, Promise<LifecycleItem>>()
    const runs = plan.map((registration) => {
      // 拓扑顺序保证依赖任务已经建立。只等待当前节点的依赖，依赖失败时直接跳过 process。
      const dependencies = registration.dependsOn.map((name) => tasks.get(name)!)
      const task = Promise.all(dependencies).then(async (items): Promise<LifecycleItem> => {
        signal?.throwIfAborted()
        const upstream = Object.freeze(
          Object.fromEntries(items.map(({ name, data }) => [name, data])),
        )
        const startedAt = performance.now()
        try {
          const data = await registration.process({
            ...context,
            upstream,
            state: sharedState,
            signal,
          })
          return { name: registration.name, data, durationMs: performance.now() - startedAt }
        } catch (error) {
          throw new LifecycleProcessorError(registration.name, error)
        }
      })
      tasks.set(registration.name, task)
      return { registration, task }
    })

    // 任务已经建立，排序只影响结果汇总。
    runs.sort((left, right) => {
      return (
        left.registration.order - right.registration.order ||
        left.registration.sequence - right.registration.sequence
      )
    })
    // 等待独立分支收尾，再按结果顺序报告首个失败。
    const results = await Promise.allSettled(runs.map(({ task }) => task))
    signal?.throwIfAborted()
    const items = results.map((result) => {
      if (result.status === "rejected") {
        throw result.reason
      }
      return result.value
    })
    return {
      items,
      data: Object.fromEntries(items.map(({ name, data }) => [name, data])),
      state: sharedState,
    }
  }
}

/**
 * 验证整张图，再生成可以依次建立节点任务的拓扑顺序。
 *
 * @param registrations 本次运行开始时取得的注册快照。
 * @returns 每个节点都排在其直接依赖之后的注册列表。
 * @throws {Error} 存在缺失依赖或循环依赖。
 */
function planExecution<TContext extends object>(
  registrations: readonly Registration<TContext>[],
): Registration<TContext>[] {
  const nodes = new Map<string, PlanNode<TContext>>()
  for (const registration of registrations) {
    nodes.set(registration.name, {
      registration,
      dependents: [],
      remaining: registration.dependsOn.length,
    })
  }
  for (const node of nodes.values()) {
    for (const name of node.registration.dependsOn) {
      const dependency = nodes.get(name)
      if (dependency === undefined) {
        throw new Error(`生命周期处理器 '${node.registration.name}' 缺少依赖节点 '${name}'`)
      }
      dependency.dependents.push(node)
    }
  }

  // 从无依赖的节点开始，沿反向依赖边递减计数。遍历中追加的节点会接着被处理。
  const ready = [...nodes.values()].filter((node) => node.remaining === 0)
  for (const node of ready) {
    for (const dependent of node.dependents) {
      dependent.remaining -= 1
      if (dependent.remaining === 0) {
        ready.push(dependent)
      }
    }
  }
  if (ready.length !== nodes.size) {
    // 仍无法入队的节点包含环上的节点，以及依赖这些节点的下游。
    const blocked = [...nodes.values()]
      .filter((node) => node.remaining > 0)
      .map((node) => node.registration.name)
    throw new Error(`生命周期图存在依赖环，无法调度：${blocked.join("、")}`)
  }
  return ready.map(({ registration }) => registration)
}
