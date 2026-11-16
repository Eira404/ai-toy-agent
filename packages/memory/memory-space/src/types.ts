/**
 * `toy-memory-space` 的公共类型契约。
 *
 * 空间是用户创建的一等资源，可绑定多个娃娃（device）；软删除用 status 标记，
 * 只改状态、不物理删行，天然支持恢复。跨包只通过这里导出的类型沟通。
 */

/** 空间生命周期；deleted 空间对检索与解析均不可见。 */
export type SpaceStatus = "active" | "deleted"

/** 一个记忆空间；`userId` 是创建者（所有者）。 */
export interface MemorySpace {
  readonly memorySpaceId: string
  readonly userId: string
  /** 空间名，可空；空串归一化为 null。 */
  readonly name: string | null
  readonly status: SpaceStatus
  readonly createdAt: string
  readonly updatedAt: string
}

/** 娃娃与空间的绑定关系；娃娃身份由 `(userId, deviceId)` 成对唯一确定。 */
export interface DeviceBinding {
  readonly userId: string
  readonly deviceId: string
  readonly memorySpaceId: string
  readonly createdAt: string
}

/** 创建空间的输入；`name` 可选，省略或空串时为 null。 */
export interface CreateSpaceInput {
  readonly userId: string
  readonly name?: string
}

/** 绑定/改绑娃娃到空间的输入。 */
export interface BindDeviceInput {
  readonly userId: string
  readonly deviceId: string
  readonly memorySpaceId: string
}

/** `listSpaces` / `countSpaces` 的过滤选项。 */
export interface ListSpacesOptions {
  /** true 返回已删空间；省略时只返回 active。 */
  readonly includeDeleted?: boolean
}
