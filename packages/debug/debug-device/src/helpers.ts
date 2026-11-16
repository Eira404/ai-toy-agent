import type { RelationalFilter } from "toy-storage-relational"
import { DebugDeviceError } from "./error.js"

/** 构造单字段相等条件。 */
export function eq(field: string, value: string): RelationalFilter {
  return { type: "eq", field, value }
}

export function nonEmpty(value: string, name: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new DebugDeviceError("invalid-input", `${name} 必须是非空字符串`)
  }
}

export function optionalString(value: string | undefined, name: string): string | null {
  if (value === undefined) {
    return null
  }
  if (typeof value !== "string") {
    throw new DebugDeviceError("invalid-input", `${name} 必须是字符串`)
  }
  return value
}

export function nullableString(value: string | null | undefined, name: string): string | null {
  if (value === undefined || value === null) {
    return null
  }
  if (typeof value !== "string") {
    throw new DebugDeviceError("invalid-input", `${name} 必须是字符串或 null`)
  }
  return value
}

export function optionalAge(value: number | undefined): number | null {
  if (value === undefined) {
    return null
  }
  return age(value)
}

export function nullableAge(value: number | null | undefined): number | null {
  if (value === undefined || value === null) {
    return null
  }
  return age(value)
}

function age(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 150) {
    throw new DebugDeviceError("invalid-input", "age 必须是 0 到 150 的安全整数")
  }
  return value
}

export function timestamp(value: string, name: string): void {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new DebugDeviceError("invalid-input", `${name} 必须是有效的时间字符串`)
  }
}

export function pageLimit(value: number | undefined): number {
  const limit = value ?? 10
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new DebugDeviceError("invalid-input", "limit 必须是 1 到 100 的安全整数")
  }
  return limit
}
