/**
 * `toy-memory-fast` 的插件配置与索引补写退避参数。
 *
 * 检索阈值与退避参数统一由宿主在装配时提供，不写在方法签名里；
 * 字段长度硬限制独立于 Long（Fast 需要完整保存尚未整理的新增证据）。
 */

/** 宿主装配 `FastMemory` 时传入的配置。 */
export interface FastConfig {
  /** 关系型存储实例名称，默认 `main`。 */
  readonly relationalSource?: string
  /** 向量存储实例名称，默认 `main`。 */
  readonly vectorSource?: string
  /** Embedding 路由名，例如 `dashscope`；`runEmbeddingJobs` 必需。 */
  readonly embeddingProvider: string
  /** Embedding 模型名，例如 `text-embedding-v3`。 */
  readonly embeddingModel: string

  /** 标题硬限制字符数，默认 80。 */
  readonly maxTitleLength?: number
  /** 摘要硬限制字符数，默认 300。 */
  readonly maxSummaryLength?: number
  /** 正文硬限制字符数，默认 4000。 */
  readonly maxBodyLength?: number

  /** 向量相似度命中阈值，默认 0.3（`1 - cosine distance`）。 */
  readonly minVectorScore?: number
  /** 向量结果不足时按相似度补足的最低数量，默认 1。 */
  readonly minVectorCount?: number
  /** 向量结果截取上限，默认 10。 */
  readonly maxVectorCount?: number

  /** 单次认领待办数量，默认 50。 */
  readonly batchSize?: number
  /** 租约时长毫秒，默认 120000。 */
  readonly leaseMs?: number
  /** 失败重试上限（含首次），默认 5。 */
  readonly maxAttempts?: number
  /** 指数退避基数毫秒，默认 2000。 */
  readonly backoffBaseMs?: number
  /** 退避是否叠加随机抖动，默认 true。 */
  readonly backoffJitter?: boolean

  /** append 后是否自动 fire-and-forget 触发一次向量补写，默认 true。 */
  readonly autoIndex?: boolean

  /** 时间源注入，测试可用固定时钟；默认取系统当前时间。 */
  readonly now?: () => string
}

/** 填充默认值并完成校验后的内部配置，service 只读取这一份。 */
export interface ResolvedFastConfig {
  readonly relationalSource: string
  readonly vectorSource: string
  readonly embeddingProvider: string
  readonly embeddingModel: string
  readonly maxTitleLength: number
  readonly maxSummaryLength: number
  readonly maxBodyLength: number
  readonly minVectorScore: number
  readonly minVectorCount: number
  readonly maxVectorCount: number
  readonly batchSize: number
  readonly leaseMs: number
  readonly maxAttempts: number
  readonly backoffBaseMs: number
  readonly backoffJitter: boolean
  readonly autoIndex: boolean
  readonly now: () => string
}

const DEFAULTS = {
  relationalSource: "main",
  vectorSource: "main",
  maxTitleLength: 80,
  maxSummaryLength: 300,
  maxBodyLength: 4000,
  minVectorScore: 0.3,
  minVectorCount: 1,
  maxVectorCount: 10,
  batchSize: 50,
  leaseMs: 120_000,
  maxAttempts: 5,
  backoffBaseMs: 2_000,
  backoffJitter: true,
  autoIndex: true,
} as const

/** 合并默认值并校验关键字段，供 `FastMemory` 构造函数调用。 */
export function resolveFastConfig(config: FastConfig): ResolvedFastConfig {
  if (typeof config.embeddingProvider !== "string" || config.embeddingProvider.trim().length === 0) {
    throw new Error("embeddingProvider 必须是非空字符串")
  }
  if (typeof config.embeddingModel !== "string" || config.embeddingModel.trim().length === 0) {
    throw new Error("embeddingModel 必须是非空字符串")
  }
  return {
    relationalSource: config.relationalSource ?? DEFAULTS.relationalSource,
    vectorSource: config.vectorSource ?? DEFAULTS.vectorSource,
    embeddingProvider: config.embeddingProvider,
    embeddingModel: config.embeddingModel,
    maxTitleLength: config.maxTitleLength ?? DEFAULTS.maxTitleLength,
    maxSummaryLength: config.maxSummaryLength ?? DEFAULTS.maxSummaryLength,
    maxBodyLength: config.maxBodyLength ?? DEFAULTS.maxBodyLength,
    minVectorScore: config.minVectorScore ?? DEFAULTS.minVectorScore,
    minVectorCount: config.minVectorCount ?? DEFAULTS.minVectorCount,
    maxVectorCount: config.maxVectorCount ?? DEFAULTS.maxVectorCount,
    batchSize: config.batchSize ?? DEFAULTS.batchSize,
    leaseMs: config.leaseMs ?? DEFAULTS.leaseMs,
    maxAttempts: config.maxAttempts ?? DEFAULTS.maxAttempts,
    backoffBaseMs: config.backoffBaseMs ?? DEFAULTS.backoffBaseMs,
    backoffJitter: config.backoffJitter ?? DEFAULTS.backoffJitter,
    autoIndex: config.autoIndex ?? DEFAULTS.autoIndex,
    now: config.now ?? (() => new Date().toISOString()),
  }
}

/**
 * 计算第 `attempt` 次失败后的退避等待毫秒数。
 *
 * `attempt` 从 1 开始：第 1 次失败等待 `base`，第 2 次等待 `2 * base`，
 * 第 3 次等待 `4 * base`……指数封顶到 2^30 防止溢出。开启抖动时在
 * `[base, 2 * base)` 内均匀随机，避免多任务同时重试形成对齐风暴。
 */
export function computeBackoffDelay(
  attempt: number,
  baseMs: number,
  jitter: boolean,
): number {
  const factor = 2 ** Math.min(attempt - 1, 30)
  const base = baseMs * factor
  return jitter ? base + Math.floor(Math.random() * base) : base
}
