import type { JsonValue } from "toy-storage-relational"

/**
 * `toy-memory-long` 的公共类型契约。
 *
 * 跨包只通过这里导出的类型沟通：`LongBlock`、`LongDetail` 与价值单元
 * 由本包拥有，`toy-memory-read` / `toy-memory-daily` / `toy-memory-weekly`
 * 只读本包明确导出的契约。
 */

/** 范围隔离：宿主已校验的用户与记忆空间。 */
export interface Scope {
  readonly userId: string
  readonly memorySpaceId: string
}

/** Long 记忆的 Domain 枚举，只负责分类，不代表固定记忆块。 */
export type LongDomain = "self" | "person" | "project" | "topic" | "entity" | "event"

/** 价值单元的生命周期：active / observing 参与检索，archived 不参与。 */
export type LifecycleStatus = "active" | "observing" | "archived"

/**
 * 价值遗忘系统维护的存储单元。
 *
 * `version` 标识价值系统版本，切换系统时据此识别 `state` 结构；
 * `state` 是 opaque JSON（含当前价值、遗忘时间、I/S/P/A 等），
 * 记忆系统不解析、不计算，只原样存取。生命周期通过独立的 `lifecycleStatus` 暴露。
 */
export interface ValueState {
  readonly valueData: JsonValue
  readonly valueVersion: string
}

/** 一条细节补充，是独立的价值单元，`detailId` 即价值单元 ID。 */
export interface LongDetail {
  readonly detailId: string
  readonly summary: string
  readonly body: string
  readonly lifecycleStatus: LifecycleStatus
  readonly value: ValueState
  readonly createdAt: string
  readonly updatedAt: string
}

/** 一个记忆块：Domain + 别名 + summary + 一条当下概括 + 零或多条细节。 */
export interface LongBlock {
  readonly blockId: string
  readonly domain: LongDomain
  readonly title: string
  readonly aliases: readonly string[]
  readonly summary: string
  readonly overviewBody: string
  readonly lifecycleStatus: LifecycleStatus
  readonly value: ValueState
  readonly details: readonly LongDetail[]
  readonly createdAt: string
  readonly updatedAt: string
  /** 正文内容（不含价值/生命周期）最近一次变化的时间，供 Weekly 判断“内容是否变过”。 */
  readonly contentUpdatedAt: string
}

/** 面向列表与召回的轻量块摘要，不含正文、细节与价值状态。 */
export interface LongBlockSummary {
  readonly blockId: string
  readonly domain: LongDomain
  readonly title: string
  readonly aliases: readonly string[]
  readonly summary: string
  readonly lifecycleStatus: LifecycleStatus
  readonly updatedAt: string
}

/** 在线检索输入；`queryVector` 为 null 表示 Embedding 失败，只做 title/alias 匹配。 */
export interface LongSearchInput {
  readonly scope: Scope
  /** 专用记忆检索 Query，用于规范化后的完全匹配。 */
  readonly query: string
  readonly queryVector: readonly number[] | null
}

/** 块进入检索结果的原因。 */
export type LongBlockHitReason = "TITLE_MATCH" | "BLOCK_VECTOR" | "PARENT_CONTEXT"

/** 检索命中的细节；score 为相似度（越大越相关），null 表示非向量命中。 */
export interface LongDetailHit {
  readonly detailId: string
  readonly summary: string
  readonly body: string
  readonly score: number | null
}

/** 检索返回的完整块命中项。 */
export interface LongBlockHit {
  readonly blockId: string
  readonly domain: LongDomain
  readonly title: string
  readonly aliases: readonly string[]
  readonly summary: string
  readonly overviewBody: string
  readonly reason: LongBlockHitReason
  readonly score: number | null
  readonly details: readonly LongDetailHit[]
}

/**
 * 一次检索的结果。`status` 描述 Long 自身各分支是否成功：
 * `COMPLETE` 全部应执行分支成功，`PARTIAL` 部分失败但仍有可信结果，
 * `UNAVAILABLE` 没有任何分支能形成结果。由上层（`toy-memory-read`）
 * 与 Fast 结果汇总成整体状态。
 */
export interface LongSearchResult {
  readonly status: "COMPLETE" | "PARTIAL" | "UNAVAILABLE"
  readonly blocks: readonly LongBlockHit[]
}

/** 记忆块的可变内容（不含价值状态与细节）。 */
export interface LongBlockContent {
  readonly domain: LongDomain
  readonly title: string
  readonly aliases: readonly string[]
  readonly summary: string
  readonly overviewBody: string
  readonly lifecycleStatus: LifecycleStatus
}

/**
 * 细节变更（显式模型，对齐 v1 stage-6 的 CREATE/UPDATE/ARCHIVE）。
 *
 * `UPDATE` 同时携带旧信息（old*）与新信息，供审计与一致性核对；
 * `summaryVector` 是调用方（Daily/Weekly）准备好的 summary Embedding，
 * Long 包不生成向量，只负责写入/删除向量索引。
 */
export type LongDetailChange =
  | {
      readonly kind: "CREATE"
      readonly summary: string
      readonly summaryVector: readonly number[]
      readonly body: string
      readonly lifecycleStatus: LifecycleStatus
      readonly value: ValueState
    }
  | {
      readonly kind: "UPDATE"
      readonly detailId: string
      readonly oldSummary: string
      readonly oldBody: string
      readonly oldValue: ValueState
      readonly summary: string
      readonly summaryVector: readonly number[]
      readonly body: string
      readonly lifecycleStatus: LifecycleStatus
      readonly value: ValueState
    }
  | {
      readonly kind: "ARCHIVE"
      readonly detailId: string
      readonly oldValue: ValueState
    }

/** 块变更（显式模型）；ARCHIVE 整块归档，连带全部细节，不需要再列细节变更。 */
export type LongBlockChange =
  | {
      readonly kind: "CREATE"
      readonly content: LongBlockContent
      readonly summaryVector: readonly number[]
      readonly value: ValueState
      readonly details: readonly LongDetailChange[]
    }
  | {
      readonly kind: "UPDATE"
      readonly blockId: string
      readonly oldContent: LongBlockContent
      readonly oldValue: ValueState
      readonly content: LongBlockContent
      readonly summaryVector: readonly number[]
      readonly value: ValueState
      readonly details: readonly LongDetailChange[]
    }
  | {
      readonly kind: "ARCHIVE"
      readonly blockId: string
      readonly oldValue: ValueState
    }

/** 一次 Daily/Weekly 提交的全部 Long 变更。 */
export interface LongChangeSet {
  readonly changes: readonly LongBlockChange[]
}

/** `applyChanges` 的结果。 */
export interface LongApplyResult {
  readonly blockIds: readonly string[]
  readonly archivedBlockIds: readonly string[]
}

/** 分页游标：按排序时间字段与 block_id 稳定定位，倒序浏览。 */
export interface LongBlockCursor {
  /** 排序时间值：orderBy=updatedAt 时是 updated_at，orderBy=createdAt 时是 created_at。 */
  readonly sortAt: string
  readonly blockId: string
}

/** `listBySpace` 的运维分页输入。 */
export interface ListLongInput {
  readonly scope: Scope
  /** 每页条数，默认 20，范围 1-100。 */
  readonly limit?: number
  /** 上一页游标，省略时从最新一条开始。 */
  readonly before?: LongBlockCursor
  /** 可选：只看某个 Domain。 */
  readonly domain?: LongDomain
  /** 可选：只看某个生命周期（运维查看归档/观察）。 */
  readonly lifecycle?: LifecycleStatus
  /** 排序时间字段，默认 updatedAt。 */
  readonly orderBy?: "updatedAt" | "createdAt"
}

/** `listBySpace` 的分页结果；`nextCursor` 为 undefined 表示没有下一页。 */
export interface LongBlockPage {
  readonly items: readonly LongBlockSummary[]
  readonly nextCursor: LongBlockCursor | undefined
}
