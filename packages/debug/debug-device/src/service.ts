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
import { DebugDeviceError } from "./error.js"
import {
  eq,
  nonEmpty,
  nullableAge,
  nullableString,
  optionalAge,
  optionalString,
  pageLimit,
  timestamp,
} from "./helpers.js"
import { KeyedLock } from "./lock.js"
import { assertDevicesSchema, deviceFromRow, deviceRow } from "./relational.js"
import { DEVICES_TABLE, devicesRelationalSchema } from "./schema.js"
import type {
  CreateDeviceInput,
  DebugDeviceConfig,
  DeviceCursor,
  DeviceRecord,
  EnsureDeviceResult,
  ListDevicesInput,
  Page,
  UpdateDeviceInput,
} from "./types.js"

declare module "cordis" {
  interface Context {
    debugDevices: DebugDevices
  }
}

/** Debug 设备（娃娃）表定义与关系型操作的业务封装；仅供 debug。 */
export class DebugDevices extends Service {
  static inject = ["storage", "storageRelational"]

  private readonly sourceName: string
  private readonly locks = new KeyedLock()
  private source: RelationalAdapter | undefined

  /**
   * @param ctx 已挂载命名存储和关系型协议的 Cordis 上下文。
   * @param config 要使用的关系型存储实例名称。
   */
  constructor(ctx: Context, config: DebugDeviceConfig = {}) {
    super(ctx, "debugDevices")
    this.sourceName = config.sourceName ?? "main"
  }

  /** 核对 adapter 的表结构；关系型实例不存在时拒绝初始化。 */
  [Service.init](): void {
    const source = this.ctx.storage.tryGet<RelationalAdapter>("relational", this.sourceName)
    if (source === undefined) {
      throw new DebugDeviceError(
        "source-not-ready",
        `关系型存储实例 'relational/${this.sourceName}' 尚未就绪`,
      )
    }
    assertDevicesSchema(source)
    this.source = source
  }

  /** 创建设备；设备已存在时抛错。 */
  createDevice(input: CreateDeviceInput): Promise<DeviceRecord> {
    nonEmpty(input.deviceId, "deviceId")
    return this.locks.with(`device:${input.deviceId}`, async () => {
      if ((await this.getDevice(input.deviceId)) !== undefined) {
        throw new DebugDeviceError("device-exists", `设备 '${input.deviceId}' 已存在`)
      }
      const device = this.buildDevice(input)
      const operation = {
        type: "insert",
        table: DEVICES_TABLE,
        value: deviceRow(device),
      } as const
      this.assertOperation(operation)
      await this.requireSource().execute(operation)
      return structuredClone(device)
    })
  }

  /** 确保设备存在：不存在则创建，存在则合并本次提供的字段。 */
  ensureDevice(input: CreateDeviceInput): Promise<EnsureDeviceResult> {
    nonEmpty(input.deviceId, "deviceId")
    return this.locks.with(`device:${input.deviceId}`, async () => {
      const existing = await this.getDevice(input.deviceId)
      if (existing === undefined) {
        const device = this.buildDevice(input)
        const operation = {
          type: "insert",
          table: DEVICES_TABLE,
          value: deviceRow(device),
        } as const
        this.assertOperation(operation)
        await this.requireSource().execute(operation)
        return { device: structuredClone(device), created: true }
      }
      const patch = this.toEnsurePatch(input)
      if (Object.keys(patch).length === 0) {
        return { device: existing, created: false }
      }
      return { device: await this.updateExisting(input.deviceId, patch), created: false }
    })
  }

  /** 批量确保多个设备存在；调试脚本一次性铺设测试设备。 */
  async seedDevices(inputs: readonly CreateDeviceInput[]): Promise<readonly EnsureDeviceResult[]> {
    const results: EnsureDeviceResult[] = []
    for (const input of inputs) {
      results.push(await this.ensureDevice(input))
    }
    return results
  }

  /** 读取单个设备；不存在时返回 undefined。 */
  async getDevice(deviceId: string): Promise<DeviceRecord | undefined> {
    nonEmpty(deviceId, "deviceId")
    const result = await this.requireSource().execute({
      type: "get",
      table: DEVICES_TABLE,
      key: deviceId,
    })
    return result.row === undefined ? undefined : deviceFromRow(result.row)
  }

  /** 按创建时间倒序分页列出设备；可只列某用户下的设备。 */
  async listDevices(input: ListDevicesInput = {}): Promise<Page<DeviceRecord, DeviceCursor>> {
    const limit = pageLimit(input.limit)
    const conditions: RelationalFilter[] = []
    if (input.userId !== undefined) {
      nonEmpty(input.userId, "userId")
      conditions.push(eq("user_id", input.userId))
    }
    if (input.before !== undefined) {
      nonEmpty(input.before.deviceId, "before.deviceId")
      timestamp(input.before.createdAt, "before.createdAt")
      conditions.push({
        type: "or",
        conditions: [
          { type: "lt", field: "created_at", value: input.before.createdAt },
          {
            type: "and",
            conditions: [
              { type: "eq", field: "created_at", value: input.before.createdAt },
              { type: "lt", field: "device_id", value: input.before.deviceId },
            ],
          },
        ],
      })
    }
    const where: RelationalFilter | undefined =
      conditions.length === 0 ? undefined : { type: "and", conditions }
    const result = await this.requireSource().execute({
      type: "find",
      table: DEVICES_TABLE,
      ...(where === undefined ? {} : { where }),
      orderBy: [
        { field: "created_at", direction: "desc" },
        { field: "device_id", direction: "desc" },
      ],
      limit: limit + 1,
    })
    const devices = result.rows.map(deviceFromRow)
    const visible = devices.slice(0, limit)
    const last = visible.at(-1)
    return {
      items: visible,
      nextCursor:
        devices.length > limit && last !== undefined
          ? { createdAt: last.createdAt, deviceId: last.deviceId }
          : undefined,
    }
  }

  /** 显式更新设备；null 清空对应字段（含解绑 userId、清空人设/年龄），缺失的键保持不变。 */
  updateDevice(deviceId: string, patchInput: UpdateDeviceInput): Promise<DeviceRecord> {
    nonEmpty(deviceId, "deviceId")
    const patch = this.toPatch(patchInput)
    if (Object.keys(patch).length === 0) {
      throw new DebugDeviceError("invalid-input", "patch 不能为空")
    }
    return this.locks.with(`device:${deviceId}`, () => this.updateExisting(deviceId, patch))
  }

  /** 删除设备；返回是否确实删除了记录。 */
  deleteDevice(deviceId: string): Promise<boolean> {
    nonEmpty(deviceId, "deviceId")
    return this.locks.with(`device:${deviceId}`, async () => {
      const operation = {
        type: "delete",
        table: DEVICES_TABLE,
        where: eq("device_id", deviceId),
      } as const
      this.assertOperation(operation)
      const result = await this.requireSource().execute(operation)
      return result.affectedRows === 1
    })
  }

  private buildDevice(input: CreateDeviceInput): DeviceRecord {
    const now = new Date().toISOString()
    return {
      deviceId: input.deviceId,
      userId: nullableString(input.userId, "userId"),
      displayName: optionalString(input.displayName, "displayName"),
      note: optionalString(input.note, "note"),
      persona: optionalString(input.persona, "persona"),
      age: optionalAge(input.age),
      payload: input.payload === undefined ? null : this.snapshotJson(input.payload),
      createdAt: now,
      updatedAt: now,
    }
  }

  private toEnsurePatch(input: CreateDeviceInput): Record<string, JsonValue> {
    const patch: Record<string, JsonValue> = {}
    if (input.userId !== undefined) {
      patch.user_id = nullableString(input.userId, "userId")
    }
    if (input.displayName !== undefined) {
      patch.display_name = optionalString(input.displayName, "displayName")
    }
    if (input.note !== undefined) {
      patch.note = optionalString(input.note, "note")
    }
    if (input.persona !== undefined) {
      patch.persona = optionalString(input.persona, "persona")
    }
    if (input.age !== undefined) {
      patch.age = optionalAge(input.age)
    }
    if (input.payload !== undefined) {
      patch.payload = this.snapshotJson(input.payload)
    }
    return patch
  }

  private toPatch(input: UpdateDeviceInput): Record<string, JsonValue> {
    const patch: Record<string, JsonValue> = {}
    if ("userId" in input) {
      patch.user_id = nullableString(input.userId, "userId")
    }
    if ("displayName" in input) {
      patch.display_name = nullableString(input.displayName, "displayName")
    }
    if ("note" in input) {
      patch.note = nullableString(input.note, "note")
    }
    if ("persona" in input) {
      patch.persona = nullableString(input.persona, "persona")
    }
    if ("age" in input) {
      patch.age = nullableAge(input.age)
    }
    if ("payload" in input) {
      patch.payload = this.snapshotJson(input.payload ?? null)
    }
    return patch
  }

  private async updateExisting(
    deviceId: string,
    patch: Record<string, JsonValue>,
  ): Promise<DeviceRecord> {
    const fullPatch = { ...patch, updated_at: new Date().toISOString() }
    const operation = {
      type: "update",
      table: DEVICES_TABLE,
      where: eq("device_id", deviceId),
      patch: fullPatch,
    } as const
    this.assertOperation(operation)
    const result = await this.requireSource().execute(operation)
    if (result.affectedRows !== 1) {
      throw new DebugDeviceError("device-not-found", `设备 '${deviceId}' 不存在`)
    }
    return this.requireExistingDevice(deviceId)
  }

  private async requireExistingDevice(deviceId: string): Promise<DeviceRecord> {
    const device = await this.getDevice(deviceId)
    if (device === undefined) {
      throw new DebugDeviceError("device-not-found", `设备 '${deviceId}' 不存在`)
    }
    return device
  }

  private requireSource(): RelationalAdapter {
    if (this.source === undefined) {
      throw new DebugDeviceError("source-not-ready", "关系型存储实例尚未初始化")
    }
    return this.source
  }

  private assertOperation(operation: RelationalOperation): void {
    this.ctx.storageRelational.assertOperation(devicesRelationalSchema, operation)
  }

  private snapshotJson(value: JsonValue): JsonValue {
    if (value === null) {
      return null
    }
    if (!this.ctx.storageRelational.isJsonValue(value)) {
      throw new DebugDeviceError("invalid-input", "payload 必须是可 JSON 化的数据")
    }
    return structuredClone(value)
  }
}

export default DebugDevices
