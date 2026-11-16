/**
 * `toy-memory-long` 的插件配置：存储实例路由、检索阈值与容量限制。
 *
 * 检索阈值与容量均属产品级统一配置，由宿主装配时提供，不写在方法签名里；
 * 容量硬限制独立于 Fast（Long 正文是整理后的长期认知，通常更短）。
 */

/** 宿主装配 `LongMemory` 时传入的配置。 */
export interface LongConfig {
  /** 关系型存储实例名称，默认 `main`。 */
  readonly relationalSource?: string
  /** 向量存储实例名称，默认 `main`；缺失时检索降级为 title/alias 路。 */
  readonly vectorSource?: string

  /** 弱检索块层 summary 向量相似度阈值（`1 - cosine distance`），默认 0.3。 */
  readonly blockVectorThreshold?: number
  /** 弱检索块层最低返回数量，不足时按相似度补足，默认 3。 */
  readonly blockMinResults?: number
  /** 弱检索块层最大返回数量，默认 10。 */
  readonly blockMaxResults?: number
  /** 弱检索块内细节 summary 向量阈值，默认 0.3。 */
  readonly detailVectorThreshold?: number
  /** 弱检索每个命中块的最低细节数量，默认 1。 */
  readonly detailMinPerBlock?: number
  /** 弱检索每个命中块的最大细节数量，默认 5。 */
  readonly detailMaxPerBlock?: number
  /** 强检索平级向量阈值，默认 0.3。 */
  readonly strongVectorThreshold?: number
  /** 强检索平级向量最低命中项数量，默认 3。 */
  readonly strongMinResults?: number
  /** 强检索平级向量最大命中项数量，默认 10。 */
  readonly strongMaxResults?: number

  /** 当下概括 body：LLM 生成目标字数，默认 300。 */
  readonly overviewBodyTarget?: number
  /** 当下概括 body：程序硬阈值，默认 400。 */
  readonly overviewBodyHard?: number
  /** 细节 body：LLM 生成目标字数，默认 300。 */
  readonly detailBodyTarget?: number
  /** 细节 body：程序硬阈值，默认 400。 */
  readonly detailBodyHard?: number
  /** 块 title：LLM 生成目标字数，默认 30。 */
  readonly blockTitleTarget?: number
  /** 块 title：程序硬阈值，默认 40。 */
  readonly blockTitleHard?: number
  /** 块 summary：LLM 生成目标字数，默认 80。 */
  readonly blockSummaryTarget?: number
  /** 块 summary：程序硬阈值，默认 120。 */
  readonly blockSummaryHard?: number
  /** 细节 summary：LLM 生成目标字数，默认 40。 */
  readonly detailSummaryTarget?: number
  /** 细节 summary：程序硬阈值，默认 60。 */
  readonly detailSummaryHard?: number

  /** 时间源注入，测试可用固定时钟；默认取系统当前时间。 */
  readonly now?: () => string
}

/** 填充默认值后的内部配置，service 只读取这一份。 */
export interface ResolvedLongConfig {
  readonly relationalSource: string
  readonly vectorSource: string
  readonly blockVectorThreshold: number
  readonly blockMinResults: number
  readonly blockMaxResults: number
  readonly detailVectorThreshold: number
  readonly detailMinPerBlock: number
  readonly detailMaxPerBlock: number
  readonly strongVectorThreshold: number
  readonly strongMinResults: number
  readonly strongMaxResults: number
  readonly overviewBodyTarget: number
  readonly overviewBodyHard: number
  readonly detailBodyTarget: number
  readonly detailBodyHard: number
  readonly blockTitleTarget: number
  readonly blockTitleHard: number
  readonly blockSummaryTarget: number
  readonly blockSummaryHard: number
  readonly detailSummaryTarget: number
  readonly detailSummaryHard: number
  readonly now: () => string
}

const DEFAULTS = {
  relationalSource: "main",
  vectorSource: "main",
  blockVectorThreshold: 0.3,
  blockMinResults: 3,
  blockMaxResults: 10,
  detailVectorThreshold: 0.3,
  detailMinPerBlock: 1,
  detailMaxPerBlock: 5,
  strongVectorThreshold: 0.3,
  strongMinResults: 3,
  strongMaxResults: 10,
  overviewBodyTarget: 300,
  overviewBodyHard: 400,
  detailBodyTarget: 300,
  detailBodyHard: 400,
  blockTitleTarget: 30,
  blockTitleHard: 40,
  blockSummaryTarget: 80,
  blockSummaryHard: 120,
  detailSummaryTarget: 40,
  detailSummaryHard: 60,
} as const

/** 合并默认值，供 `LongMemory` 构造函数调用。 */
export function resolveLongConfig(config: LongConfig = {}): ResolvedLongConfig {
  return {
    relationalSource: config.relationalSource ?? DEFAULTS.relationalSource,
    vectorSource: config.vectorSource ?? DEFAULTS.vectorSource,
    blockVectorThreshold: config.blockVectorThreshold ?? DEFAULTS.blockVectorThreshold,
    blockMinResults: config.blockMinResults ?? DEFAULTS.blockMinResults,
    blockMaxResults: config.blockMaxResults ?? DEFAULTS.blockMaxResults,
    detailVectorThreshold: config.detailVectorThreshold ?? DEFAULTS.detailVectorThreshold,
    detailMinPerBlock: config.detailMinPerBlock ?? DEFAULTS.detailMinPerBlock,
    detailMaxPerBlock: config.detailMaxPerBlock ?? DEFAULTS.detailMaxPerBlock,
    strongVectorThreshold: config.strongVectorThreshold ?? DEFAULTS.strongVectorThreshold,
    strongMinResults: config.strongMinResults ?? DEFAULTS.strongMinResults,
    strongMaxResults: config.strongMaxResults ?? DEFAULTS.strongMaxResults,
    overviewBodyTarget: config.overviewBodyTarget ?? DEFAULTS.overviewBodyTarget,
    overviewBodyHard: config.overviewBodyHard ?? DEFAULTS.overviewBodyHard,
    detailBodyTarget: config.detailBodyTarget ?? DEFAULTS.detailBodyTarget,
    detailBodyHard: config.detailBodyHard ?? DEFAULTS.detailBodyHard,
    blockTitleTarget: config.blockTitleTarget ?? DEFAULTS.blockTitleTarget,
    blockTitleHard: config.blockTitleHard ?? DEFAULTS.blockTitleHard,
    blockSummaryTarget: config.blockSummaryTarget ?? DEFAULTS.blockSummaryTarget,
    blockSummaryHard: config.blockSummaryHard ?? DEFAULTS.blockSummaryHard,
    detailSummaryTarget: config.detailSummaryTarget ?? DEFAULTS.detailSummaryTarget,
    detailSummaryHard: config.detailSummaryHard ?? DEFAULTS.detailSummaryHard,
    now: config.now ?? (() => new Date().toISOString()),
  }
}
