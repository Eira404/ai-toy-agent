import type { JsonValue } from "toy-storage-relational"

/** 一条 Debug 用户记录；displayName/note 可空，payload 可为任意 JSON 或 null。 */
export interface UserRecord {
  readonly userId: string
  readonly displayName: string | null
  readonly note: string | null
  readonly payload: JsonValue
  readonly createdAt: string
  readonly updatedAt: string
}

/** 创建（或确保存在）一个用户时的输入。 */
export interface CreateUserInput {
  readonly userId: string
  readonly displayName?: string
  readonly note?: string
  readonly payload?: Exclude<JsonValue, null>
}

/** 显式更新用户时允许的字段；null 用于清空对应字段。 */
export interface UpdateUserInput {
  readonly displayName?: string | null
  readonly note?: string | null
  readonly payload?: JsonValue
}

/** ensureUser 的结果，用于区分本次是新建还是合并更新。 */
export interface EnsureUserResult {
  readonly user: UserRecord
  readonly created: boolean
}

/** 按创建时间倒序分页列出用户的游标。 */
export interface UserCursor {
  readonly createdAt: string
  readonly userId: string
}

/** 一页用户列表的查询参数。 */
export interface ListUsersInput {
  readonly limit?: number
  readonly before?: UserCursor
}

/** 通用分页结果；nextCursor 为 undefined 表示没有下一页。 */
export interface Page<T, Cursor> {
  readonly items: readonly T[]
  readonly nextCursor: Cursor | undefined
}

/** 插件初始化配置；关系型实例必须先注册。 */
export interface DebugUserConfig {
  /** 已连接的关系型存储实例名称；默认 main。 */
  readonly sourceName?: string
}
