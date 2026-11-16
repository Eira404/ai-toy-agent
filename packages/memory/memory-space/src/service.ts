import { randomUUID } from "node:crypto"
import { Service, type Context } from "cordis"
import "toy-storage"
import type { RelationalAdapter, RelationalRecord } from "toy-storage-relational"
import { resolveSpaceConfig, type ResolvedSpaceConfig, type SpaceConfig } from "./config.js"
import { MemorySpaceError } from "./error.js"
import {
  andWhere,
  assertSpaceSchema,
  bindingFromRow,
  bindingRow,
  eq,
  spaceFromRow,
  spaceRow,
} from "./relational.js"
import { DEVICES_TABLE, SPACES_TABLE } from "./schema.js"
import type {
  BindDeviceInput,
  CreateSpaceInput,
  DeviceBinding,
  ListSpacesOptions,
  MemorySpace,
} from "./types.js"

declare module "cordis" {
  interface Context {
    memorySpace: MemorySpaceService
  }
}

/**
 * 记忆空间管理服务。
 *
 * 职责：用户创建/重命名/软删除空间，绑定娃娃到空间，以及解析娃娃当前
 * 的 active 空间。本包不接 Session，`resolveMemorySpace` 由上层在 Session
 * 预处理阶段调用并把结果写入 Session payload。
 *
 * 依赖：命名关系型存储（`relational` 实例）。
 */
export class MemorySpaceService extends Service {
  static inject = ["storage"]

  private readonly config: ResolvedSpaceConfig
  private relational: RelationalAdapter | undefined

  /** @param config 装配配置；默认关系型实例 `main`，空间名上限 64。 */
  constructor(ctx: Context, config: SpaceConfig = {}) {
    super(ctx, "memorySpace")
    this.config = resolveSpaceConfig(config)
  }

  /** 核对命名关系型实例并校验 schema。 */
  [Service.init](): void {
    const relational = this.ctx.storage.tryGet<RelationalAdapter>(
      "relational",
      this.config.relationalSource,
    )
    if (relational === undefined) {
      throw new MemorySpaceError(
        "source-not-ready",
        `关系型存储实例 'relational/${this.config.relationalSource}' 尚未就绪`,
      )
    }
    this.relational = relational
    assertSpaceSchema(relational)
  }

  /**
   * 创建一个 active 空间。`name` 可选，省略或空串时为 null。
   *
   * @param input 所有者 userId 与可选空间名。
   * @returns 已落库的完整空间。
   */
  async createSpace(input: CreateSpaceInput): Promise<MemorySpace> {
    assertUserId(input.userId)
    const name = normalizeName(input.name, this.config.maxNameLength)
    const now = this.config.now()
    const space: MemorySpace = {
      memorySpaceId: randomUUID(),
      userId: input.userId,
      name,
      status: "active",
      createdAt: now,
      updatedAt: now,
    }
    await this.requireRelational().execute({
      type: "insert",
      table: SPACES_TABLE,
      value: spaceRow(space),
    })
    return space
  }

  /** 按 ID 读一个空间（含已删），不存在返回 null。运维查询，不做归属校验。 */
  async getSpace(memorySpaceId: string): Promise<MemorySpace | null> {
    assertNonEmpty(memorySpaceId, "memorySpaceId")
    const result = await this.requireRelational().execute({
      type: "get",
      table: SPACES_TABLE,
      key: memorySpaceId,
    })
    return result.row === undefined ? null : spaceFromRow(result.row)
  }

  /**
   * 列出某用户的全部空间，默认只返回 active。
   *
   * @param userId 所有者。
   * @param options `includeDeleted: true` 时包含已删空间。
   */
  async listSpaces(userId: string, options: ListSpacesOptions = {}): Promise<MemorySpace[]> {
    assertUserId(userId)
    const result = await this.requireRelational().execute({
      type: "find",
      table: SPACES_TABLE,
      where: andWhere([
        eq("user_id", userId),
        ...(options.includeDeleted === true ? [] : [eq("status", "active")]),
      ]),
      orderBy: [{ field: "created_at", direction: "asc" }],
    })
    return result.rows.map(spaceFromRow)
  }

  /**
   * 列出全部用户的空间（运维/审计查看用），默认只返回 active。
   * 不做归属校验，适合跨用户浏览。
   *
   * @param options `includeDeleted: true` 时包含已删空间。
   */
  async listAllSpaces(options: ListSpacesOptions = {}): Promise<MemorySpace[]> {
    const result = await this.requireRelational().execute({
      type: "find",
      table: SPACES_TABLE,
      ...(options.includeDeleted === true ? {} : { where: andWhere([eq("status", "active")]) }),
      orderBy: [{ field: "created_at", direction: "asc" }],
    })
    return result.rows.map(spaceFromRow)
  }

  /**
   * 设置/修改空间名；空串清空为 null。只对 active 空间生效。
   *
   * @param userId 所有者（用于归属校验）。
   * @param memorySpaceId 目标空间。
   * @param name 新空间名。
   */
  async renameSpace(userId: string, memorySpaceId: string, name: string): Promise<MemorySpace> {
    const space = await this.requireOwnedActiveSpace(userId, memorySpaceId)
    const nextName = normalizeName(name, this.config.maxNameLength)
    const updatedAt = this.config.now()
    await this.requireRelational().execute({
      type: "update",
      table: SPACES_TABLE,
      where: eq("memory_space_id", memorySpaceId),
      patch: { name: nextName, updated_at: updatedAt },
    })
    return { ...space, name: nextName, updatedAt }
  }

  /**
   * 软删除空间：只把 status 标记为 deleted，不删绑定、不物理删行。幂等。
   *
   * @param userId 所有者。
   * @param memorySpaceId 目标空间。
   */
  async deleteSpace(userId: string, memorySpaceId: string): Promise<MemorySpace> {
    const space = await this.requireOwnedSpace(userId, memorySpaceId)
    if (space.status === "deleted") {
      return space
    }
    const updatedAt = this.config.now()
    await this.requireRelational().execute({
      type: "update",
      table: SPACES_TABLE,
      where: eq("memory_space_id", memorySpaceId),
      patch: { status: "deleted", updated_at: updatedAt },
    })
    return { ...space, status: "deleted", updatedAt }
  }

  /**
   * 恢复已删空间为 active，绑定关系原样保留。幂等。
   *
   * @param userId 所有者。
   * @param memorySpaceId 目标空间。
   */
  async restoreSpace(userId: string, memorySpaceId: string): Promise<MemorySpace> {
    const space = await this.requireOwnedSpace(userId, memorySpaceId)
    if (space.status === "active") {
      return space
    }
    const updatedAt = this.config.now()
    await this.requireRelational().execute({
      type: "update",
      table: SPACES_TABLE,
      where: eq("memory_space_id", memorySpaceId),
      patch: { status: "active", updated_at: updatedAt },
    })
    return { ...space, status: "active", updatedAt }
  }

  /**
   * 绑定/改绑娃娃到空间，幂等。
   *
   * 校验目标空间 active 且属于该 userId；已绑同一空间时无变更返回原绑定，
   * 已绑别的空间时改绑（等价"移动"，刷新 created_at）。
   *
   * @param input 用户、娃娃与目标空间。
   */
  async bindDevice(input: BindDeviceInput): Promise<DeviceBinding> {
    assertUserId(input.userId)
    assertNonEmpty(input.deviceId, "deviceId")
    assertNonEmpty(input.memorySpaceId, "memorySpaceId")
    await this.requireOwnedActiveSpace(input.userId, input.memorySpaceId)

    const existing = await this.loadBinding(input.userId, input.deviceId)
    const now = this.config.now()
    if (existing === undefined) {
      await this.requireRelational().execute({
        type: "insert",
        table: DEVICES_TABLE,
        value: bindingRow(randomUUID(), input, now),
      })
      return {
        userId: input.userId,
        deviceId: input.deviceId,
        memorySpaceId: input.memorySpaceId,
        createdAt: now,
      }
    }
    if (String(existing.memory_space_id) === input.memorySpaceId) {
      return bindingFromRow(existing)
    }
    await this.requireRelational().execute({
      type: "update",
      table: DEVICES_TABLE,
      where: eq("binding_id", String(existing.binding_id)),
      patch: { memory_space_id: input.memorySpaceId, created_at: now },
    })
    return {
      userId: input.userId,
      deviceId: input.deviceId,
      memorySpaceId: input.memorySpaceId,
      createdAt: now,
    }
  }

  /**
   * 解绑娃娃；不存在绑定时抛 `binding-not-found`。
   *
   * @param userId 娃娃所属用户。
   * @param deviceId 娃娃设备。
   */
  async unbindDevice(userId: string, deviceId: string): Promise<void> {
    assertUserId(userId)
    assertNonEmpty(deviceId, "deviceId")
    const result = await this.requireRelational().execute({
      type: "delete",
      table: DEVICES_TABLE,
      where: andWhere([eq("user_id", userId), eq("device_id", deviceId)]),
    })
    if (result.affectedRows === 0) {
      throw new MemorySpaceError("binding-not-found", `娃娃 '${deviceId}' 未绑定任何记忆空间`)
    }
  }

  /** 列出某空间下的全部娃娃绑定，按绑定时间升序。运维查询。 */
  async listBoundDevices(memorySpaceId: string): Promise<DeviceBinding[]> {
    assertNonEmpty(memorySpaceId, "memorySpaceId")
    const result = await this.requireRelational().execute({
      type: "find",
      table: DEVICES_TABLE,
      where: eq("memory_space_id", memorySpaceId),
      orderBy: [{ field: "created_at", direction: "asc" }],
    })
    return result.rows.map(bindingFromRow)
  }

  /**
   * 解析娃娃当前绑定的 active 空间 ID，供 Session 预处理等上层使用。
   *
   * 未绑定，或绑定的空间已删除时返回 null。这是热路径，只做两次索引查询。
   *
   * @param userId 娃娃所属用户。
   * @param deviceId 娃娃设备。
   */
  async resolveMemorySpace(userId: string, deviceId: string): Promise<string | null> {
    assertUserId(userId)
    assertNonEmpty(deviceId, "deviceId")
    const binding = await this.loadBinding(userId, deviceId)
    if (binding === undefined) {
      return null
    }
    const space = await this.getSpace(String(binding.memory_space_id))
    return space !== null && space.status === "active" ? space.memorySpaceId : null
  }

  /**
   * 解析或创建娃娃当前绑定的 active 空间，返回空间 ID 与是否本次新建。
   *
   * 职责：供 Go conversation 门面等「用户 + 娃娃唯一确定一个空间」的上层调用——
   * 已有绑定直接复用，无绑定则原子地创建空间并绑定。空间名取 deviceId；本方法
   * 不做软删判断（调用方保证该场景不会软删空间）。
   *
   * 并发与幂等：创建空间与绑定在同一关系事务内完成；并发首次调用时
   * `(user_id, device_id)` 唯一索引会拒绝重复绑定，冲突后整个事务回滚并回读
   * 既有绑定，返回 `created: false`，不产生孤儿空间。
   *
   * @param userId 娃娃所属用户。
   * @param deviceId 娃娃设备。
   * @returns 空间 ID 与是否本次新建。
   */
  async resolveOrCreateMemorySpace(
    userId: string,
    deviceId: string,
  ): Promise<{ readonly memorySpaceId: string; readonly created: boolean }> {
    assertUserId(userId)
    assertNonEmpty(deviceId, "deviceId")

    const existing = await this.loadBinding(userId, deviceId)
    if (existing !== undefined) {
      return { memorySpaceId: String(existing.memory_space_id), created: false }
    }

    const memorySpaceId = randomUUID()
    const name = normalizeName(deviceId, this.config.maxNameLength)
    const now = this.config.now()
    try {
      await this.requireRelational().transaction(async (tx) => {
        await tx.execute({
          type: "insert",
          table: SPACES_TABLE,
          value: spaceRow({
            memorySpaceId,
            userId,
            name,
            status: "active",
            createdAt: now,
            updatedAt: now,
          }),
        })
        await tx.execute({
          type: "insert",
          table: DEVICES_TABLE,
          value: bindingRow(randomUUID(), { userId, deviceId, memorySpaceId }, now),
        })
      })
      return { memorySpaceId, created: true }
    } catch (error) {
      const committed = await this.loadBinding(userId, deviceId)
      if (committed !== undefined) {
        return { memorySpaceId: String(committed.memory_space_id), created: false }
      }
      throw error
    }
  }

  /** 统计某用户的全部空间数，默认只计 active。 */
  async countSpaces(userId: string, options: ListSpacesOptions = {}): Promise<number> {
    assertUserId(userId)
    const result = await this.requireRelational().execute({
      type: "count",
      table: SPACES_TABLE,
      where: andWhere([
        eq("user_id", userId),
        ...(options.includeDeleted === true ? [] : [eq("status", "active")]),
      ]),
    })
    return result.count
  }

  /** 统计某空间下绑定的娃娃数量。 */
  async countDevices(memorySpaceId: string): Promise<number> {
    assertNonEmpty(memorySpaceId, "memorySpaceId")
    const result = await this.requireRelational().execute({
      type: "count",
      table: DEVICES_TABLE,
      where: eq("memory_space_id", memorySpaceId),
    })
    return result.count
  }

  /** 读某娃娃的绑定行，不存在返回 undefined。 */
  private async loadBinding(userId: string, deviceId: string): Promise<RelationalRecord | undefined> {
    const result = await this.requireRelational().execute({
      type: "find",
      table: DEVICES_TABLE,
      where: andWhere([eq("user_id", userId), eq("device_id", deviceId)]),
      limit: 1,
    })
    return result.rows[0]
  }

  /** 读空间并校验归属；不存在抛 space-not-found，非所有者抛 not-owner。 */
  private async requireOwnedSpace(userId: string, memorySpaceId: string): Promise<MemorySpace> {
    const space = await this.getSpace(memorySpaceId)
    if (space === null) {
      throw new MemorySpaceError("space-not-found", `记忆空间 '${memorySpaceId}' 不存在`)
    }
    if (space.userId !== userId) {
      throw new MemorySpaceError("not-owner", `记忆空间 '${memorySpaceId}' 不属于用户 '${userId}'`)
    }
    return space
  }

  /** 读空间、校验归属并保证 active。 */
  private async requireOwnedActiveSpace(userId: string, memorySpaceId: string): Promise<MemorySpace> {
    const space = await this.requireOwnedSpace(userId, memorySpaceId)
    if (space.status === "deleted") {
      throw new MemorySpaceError("space-deleted", `记忆空间 '${memorySpaceId}' 已删除`)
    }
    return space
  }

  private requireRelational(): RelationalAdapter {
    if (this.relational === undefined) {
      throw new MemorySpaceError("source-not-ready", "关系型存储实例尚未初始化")
    }
    return this.relational
  }
}

export default MemorySpaceService

// ---------------------------------------------------------------------------
// 模块级辅助
// ---------------------------------------------------------------------------

/** 归一化空间名：undefined/null/空串 → null，否则 trim 后校验长度。 */
function normalizeName(name: unknown, maxLength: number): string | null {
  if (name === undefined || name === null) {
    return null
  }
  if (typeof name !== "string") {
    throw new MemorySpaceError("invalid-input", "name 必须是字符串")
  }
  const trimmed = name.trim()
  if (trimmed.length === 0) {
    return null
  }
  if (charCount(trimmed) > maxLength) {
    throw new MemorySpaceError("invalid-input", `name 超过 ${maxLength} 字符`)
  }
  return trimmed
}

function assertUserId(userId: string): void {
  assertNonEmpty(userId, "userId")
}

function assertNonEmpty(value: string, name: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new MemorySpaceError("invalid-input", `${name} 必须是非空字符串`)
  }
}

/** 按 Unicode 码点计数，而非 UTF-16 码元，与 v4 的字符计数口径一致。 */
function charCount(value: string): number {
  return [...value].length
}
