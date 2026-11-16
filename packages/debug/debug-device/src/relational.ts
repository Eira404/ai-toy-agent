import type {
  JsonValue,
  RelationalAdapter,
  RelationalRecord,
  RelationalTableDefinition,
} from "toy-storage-relational"
import { DebugDeviceError } from "./error.js"
import { DEVICES_TABLE, devicesRelationalSchema } from "./schema.js"
import type { DeviceRecord } from "./types.js"

/** 检查命名 adapter 是否配置了本包需要的设备表及约束。 */
export function assertDevicesSchema(adapter: RelationalAdapter): void {
  const required = devicesRelationalSchema.tables[DEVICES_TABLE]
  const actual = adapter.schema.tables[DEVICES_TABLE]
  if (actual?.primaryKey !== required.primaryKey) {
    throw new DebugDeviceError("schema-mismatch", `数据源缺少正确的 '${DEVICES_TABLE}' 表或主键`)
  }
  for (const [field, expected] of Object.entries(required.columns)) {
    const column = actual.columns[field]
    if (
      column?.type !== expected.type ||
      (column.nullable === true) !== ("nullable" in expected && expected.nullable === true)
    ) {
      throw new DebugDeviceError("schema-mismatch", `数据源字段 '${DEVICES_TABLE}.${field}' 与定义不一致`)
    }
  }
}

/** 将 Device 领域对象转换为关系型记录。 */
export function deviceRow(device: DeviceRecord): RelationalRecord {
  return {
    device_id: device.deviceId,
    user_id: device.userId,
    display_name: device.displayName,
    note: device.note,
    persona: device.persona,
    age: device.age,
    payload: device.payload,
    created_at: device.createdAt,
    updated_at: device.updatedAt,
  }
}

/** 将 adapter 返回的行还原成公开对象。 */
export function deviceFromRow(row: RelationalRecord): DeviceRecord {
  return {
    deviceId: stringField(row, "device_id"),
    userId: nullableStringField(row, "user_id"),
    displayName: nullableStringField(row, "display_name"),
    note: nullableStringField(row, "note"),
    persona: nullableStringField(row, "persona"),
    age: nullableIntegerField(row, "age"),
    payload: jsonField(row, "payload"),
    createdAt: stringField(row, "created_at"),
    updatedAt: stringField(row, "updated_at"),
  }
}

function stringField(row: RelationalRecord, field: string): string {
  const value = row[field]
  if (typeof value !== "string") {
    throw new DebugDeviceError("schema-mismatch", `数据库字段 '${field}' 不是字符串`)
  }
  return value
}

function nullableStringField(row: RelationalRecord, field: string): string | null {
  const value = row[field]
  if (value === null) {
    return null
  }
  return stringField(row, field)
}

function nullableIntegerField(row: RelationalRecord, field: string): number | null {
  const value = row[field]
  if (value === null) {
    return null
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new DebugDeviceError("schema-mismatch", `数据库字段 '${field}' 不是安全整数`)
  }
  return value
}

function jsonField(row: RelationalRecord, field: string): JsonValue {
  const value = row[field]
  if (value === undefined) {
    throw new DebugDeviceError("schema-mismatch", `数据库字段 '${field}' 缺失`)
  }
  return value
}
