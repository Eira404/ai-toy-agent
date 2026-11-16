import type { JsonValue } from "toy-storage-relational"

/** 一条 Debug 设备（娃娃）记录；userId 可空表示未绑定用户。 */
export interface DeviceRecord {
  readonly deviceId: string
  readonly userId: string | null
  readonly displayName: string | null
  readonly note: string | null
  /** 玩偶人设（完整设定文本，可直接注入 system prompt）；null 表示无人设。 */
  readonly persona: string | null
  /** 使用该玩偶的孩子年龄（岁）；null 表示未知。 */
  readonly age: number | null
  readonly payload: JsonValue
  readonly createdAt: string
  readonly updatedAt: string
}

/** 创建（或确保存在）一个设备时的输入。 */
export interface CreateDeviceInput {
  readonly deviceId: string
  readonly userId?: string | null
  readonly displayName?: string
  readonly note?: string
  readonly persona?: string
  readonly age?: number
  readonly payload?: Exclude<JsonValue, null>
}

/** 显式更新设备时允许的字段；null 用于清空对应字段（含解绑 userId、清空人设/年龄）。 */
export interface UpdateDeviceInput {
  readonly userId?: string | null
  readonly displayName?: string | null
  readonly note?: string | null
  readonly persona?: string | null
  readonly age?: number | null
  readonly payload?: JsonValue
}

/** ensureDevice 的结果，用于区分本次是新建还是合并更新。 */
export interface EnsureDeviceResult {
  readonly device: DeviceRecord
  readonly created: boolean
}

/** 按创建时间倒序分页列出设备的游标。 */
export interface DeviceCursor {
  readonly createdAt: string
  readonly deviceId: string
}

/** 一页设备列表的查询参数；可只列某用户下的设备。 */
export interface ListDevicesInput {
  readonly userId?: string
  readonly limit?: number
  readonly before?: DeviceCursor
}

/** 通用分页结果；nextCursor 为 undefined 表示没有下一页。 */
export interface Page<T, Cursor> {
  readonly items: readonly T[]
  readonly nextCursor: Cursor | undefined
}

/** 插件初始化配置；关系型实例必须先注册。 */
export interface DebugDeviceConfig {
  /** 已连接的关系型存储实例名称；默认 main。 */
  readonly sourceName?: string
}
