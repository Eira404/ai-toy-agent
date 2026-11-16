import { Service, type Context } from "cordis"
import "toy-storage"
import "toy-storage-relational"
import type {
  JsonValue,
  RelationalAdapter,
  RelationalFilter,
  RelationalOperation,
  RelationalRecord,
} from "toy-storage-relational"
import { DebugUserError } from "./error.js"
import { eq, nonEmpty, nullableString, optionalString, pageLimit, timestamp } from "./helpers.js"
import { KeyedLock } from "./lock.js"
import { assertUsersSchema, userFromRow, userRow } from "./relational.js"
import { USERS_TABLE, usersRelationalSchema } from "./schema.js"
import type {
  CreateUserInput,
  DebugUserConfig,
  EnsureUserResult,
  ListUsersInput,
  Page,
  UpdateUserInput,
  UserCursor,
  UserRecord,
} from "./types.js"

declare module "cordis" {
  interface Context {
    debugUsers: DebugUsers
  }
}

/** Debug 用户表定义与关系型操作的业务封装；仅供 debug，不参与鉴权。 */
export class DebugUsers extends Service {
  static inject = ["storage", "storageRelational"]

  private readonly sourceName: string
  private readonly locks = new KeyedLock()
  private source: RelationalAdapter | undefined

  /**
   * @param ctx 已挂载命名存储和关系型协议的 Cordis 上下文。
   * @param config 要使用的关系型存储实例名称。
   */
  constructor(ctx: Context, config: DebugUserConfig = {}) {
    super(ctx, "debugUsers")
    this.sourceName = config.sourceName ?? "main"
  }

  /** 核对 adapter 的表结构；关系型实例不存在时拒绝初始化。 */
  [Service.init](): void {
    const source = this.ctx.storage.tryGet<RelationalAdapter>("relational", this.sourceName)
    if (source === undefined) {
      throw new DebugUserError(
        "source-not-ready",
        `关系型存储实例 'relational/${this.sourceName}' 尚未就绪`,
      )
    }
    assertUsersSchema(source)
    this.source = source
  }

  /** 创建用户；用户已存在时抛错。 */
  createUser(input: CreateUserInput): Promise<UserRecord> {
    nonEmpty(input.userId, "userId")
    return this.locks.with(`user:${input.userId}`, async () => {
      if ((await this.getUser(input.userId)) !== undefined) {
        throw new DebugUserError("user-exists", `用户 '${input.userId}' 已存在`)
      }
      const user = this.buildUser(input)
      const operation = {
        type: "insert",
        table: USERS_TABLE,
        value: userRow(user),
      } as const
      this.assertOperation(operation)
      await this.requireSource().execute(operation)
      return structuredClone(user)
    })
  }

  /** 确保用户存在：不存在则创建，存在则合并本次提供的字段。 */
  ensureUser(input: CreateUserInput): Promise<EnsureUserResult> {
    nonEmpty(input.userId, "userId")
    return this.locks.with(`user:${input.userId}`, async () => {
      const existing = await this.getUser(input.userId)
      if (existing === undefined) {
        const user = this.buildUser(input)
        const operation = {
          type: "insert",
          table: USERS_TABLE,
          value: userRow(user),
        } as const
        this.assertOperation(operation)
        await this.requireSource().execute(operation)
        return { user: structuredClone(user), created: true }
      }
      const patch = this.toEnsurePatch(input)
      if (Object.keys(patch).length === 0) {
        return { user: existing, created: false }
      }
      return { user: await this.updateExisting(input.userId, patch), created: false }
    })
  }

  /** 批量确保多个用户存在；调试脚本一次性铺设测试用户。 */
  async seedUsers(inputs: readonly CreateUserInput[]): Promise<readonly EnsureUserResult[]> {
    const results: EnsureUserResult[] = []
    for (const input of inputs) {
      results.push(await this.ensureUser(input))
    }
    return results
  }

  /** 读取单个用户；不存在时返回 undefined。 */
  async getUser(userId: string): Promise<UserRecord | undefined> {
    nonEmpty(userId, "userId")
    const result = await this.requireSource().execute({
      type: "get",
      table: USERS_TABLE,
      key: userId,
    })
    return result.row === undefined ? undefined : userFromRow(result.row)
  }

  /** 按创建时间倒序分页列出用户。 */
  async listUsers(input: ListUsersInput = {}): Promise<Page<UserRecord, UserCursor>> {
    const limit = pageLimit(input.limit)
    if (input.before !== undefined) {
      nonEmpty(input.before.userId, "before.userId")
      timestamp(input.before.createdAt, "before.createdAt")
    }
    let where: RelationalFilter | undefined
    if (input.before !== undefined) {
      where = {
        type: "or",
        conditions: [
          { type: "lt", field: "created_at", value: input.before.createdAt },
          {
            type: "and",
            conditions: [
              { type: "eq", field: "created_at", value: input.before.createdAt },
              { type: "lt", field: "user_id", value: input.before.userId },
            ],
          },
        ],
      }
    }
    const result = await this.requireSource().execute({
      type: "find",
      table: USERS_TABLE,
      ...(where === undefined ? {} : { where }),
      orderBy: [
        { field: "created_at", direction: "desc" },
        { field: "user_id", direction: "desc" },
      ],
      limit: limit + 1,
    })
    const users = result.rows.map(userFromRow)
    const visible = users.slice(0, limit)
    const last = visible.at(-1)
    return {
      items: visible,
      nextCursor:
        users.length > limit && last !== undefined
          ? { createdAt: last.createdAt, userId: last.userId }
          : undefined,
    }
  }

  /** 显式更新用户；null 清空对应字段，缺失的键保持不变。 */
  updateUser(userId: string, patchInput: UpdateUserInput): Promise<UserRecord> {
    nonEmpty(userId, "userId")
    const patch = this.toPatch(patchInput)
    if (Object.keys(patch).length === 0) {
      throw new DebugUserError("invalid-input", "patch 不能为空")
    }
    return this.locks.with(`user:${userId}`, () => this.updateExisting(userId, patch))
  }

  /** 删除用户；返回是否确实删除了记录。 */
  deleteUser(userId: string): Promise<boolean> {
    nonEmpty(userId, "userId")
    return this.locks.with(`user:${userId}`, async () => {
      const operation = {
        type: "delete",
        table: USERS_TABLE,
        where: eq("user_id", userId),
      } as const
      this.assertOperation(operation)
      const result = await this.requireSource().execute(operation)
      return result.affectedRows === 1
    })
  }

  private buildUser(input: CreateUserInput): UserRecord {
    const now = new Date().toISOString()
    return {
      userId: input.userId,
      displayName: optionalString(input.displayName, "displayName"),
      note: optionalString(input.note, "note"),
      payload: input.payload === undefined ? null : this.snapshotJson(input.payload),
      createdAt: now,
      updatedAt: now,
    }
  }

  private toEnsurePatch(input: CreateUserInput): Record<string, JsonValue> {
    const patch: Record<string, JsonValue> = {}
    if (input.displayName !== undefined) {
      patch.display_name = optionalString(input.displayName, "displayName")
    }
    if (input.note !== undefined) {
      patch.note = optionalString(input.note, "note")
    }
    if (input.payload !== undefined) {
      patch.payload = this.snapshotJson(input.payload)
    }
    return patch
  }

  private toPatch(input: UpdateUserInput): Record<string, JsonValue> {
    const patch: Record<string, JsonValue> = {}
    if ("displayName" in input) {
      patch.display_name = nullableString(input.displayName, "displayName")
    }
    if ("note" in input) {
      patch.note = nullableString(input.note, "note")
    }
    if ("payload" in input) {
      patch.payload = this.snapshotJson(input.payload ?? null)
    }
    return patch
  }

  private async updateExisting(userId: string, patch: Record<string, JsonValue>): Promise<UserRecord> {
    const fullPatch = { ...patch, updated_at: new Date().toISOString() }
    const operation = {
      type: "update",
      table: USERS_TABLE,
      where: eq("user_id", userId),
      patch: fullPatch,
    } as const
    this.assertOperation(operation)
    const result = await this.requireSource().execute(operation)
    if (result.affectedRows !== 1) {
      throw new DebugUserError("user-not-found", `用户 '${userId}' 不存在`)
    }
    return this.requireExistingUser(userId)
  }

  private async requireExistingUser(userId: string): Promise<UserRecord> {
    const user = await this.getUser(userId)
    if (user === undefined) {
      throw new DebugUserError("user-not-found", `用户 '${userId}' 不存在`)
    }
    return user
  }

  private requireSource(): RelationalAdapter {
    if (this.source === undefined) {
      throw new DebugUserError("source-not-ready", "关系型存储实例尚未初始化")
    }
    return this.source
  }

  private assertOperation(operation: RelationalOperation): void {
    this.ctx.storageRelational.assertOperation(usersRelationalSchema, operation)
  }

  private snapshotJson(value: JsonValue): JsonValue {
    if (value === null) {
      return null
    }
    if (!this.ctx.storageRelational.isJsonValue(value)) {
      throw new DebugUserError("invalid-input", "payload 必须是可 JSON 化的数据")
    }
    return structuredClone(value)
  }
}

export default DebugUsers
