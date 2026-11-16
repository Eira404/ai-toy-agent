import type { RelationalFilter } from "toy-storage-relational"
import { AdminAuthError } from "./error.js"

export function objectInput(value: unknown): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new AdminAuthError("invalid-input", "参数必须是对象")
  }
}

export function text(value: unknown, name: string, max = 100): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > max) {
    throw new AdminAuthError("invalid-input", `${name} 必须是非空字符串，且不超过 ${max} 个字符`)
  }
  return value.trim()
}

export function loginName(value: unknown): string {
  const normalized = text(value, "loginName", 128).toLowerCase()
  if (!/^[a-z0-9][a-z0-9._-]{2,63}$/.test(normalized)) {
    throw new AdminAuthError(
      "invalid-input",
      "loginName 须为 3–64 位字母、数字、点、下划线或短横线，首位须为字母或数字",
    )
  }
  return normalized
}

export function password(value: unknown, creating = false): string {
  if (
    typeof value !== "string" ||
    value.length > 256 ||
    Buffer.byteLength(value, "utf8") > 512 ||
    Buffer.from(value, "utf8").toString("utf8") !== value
  ) {
    throw new AdminAuthError("invalid-input", "password 格式或长度不合法")
  }
  const length = Array.from(value).length
  if (length < (creating ? 12 : 1) || length > 128) {
    throw new AdminAuthError(
      "invalid-input",
      creating ? "新密码须为 12–128 个字符" : "password 须为 1–128 个字符",
    )
  }
  return value
}

export function positive(value: unknown, name: string, max = 2_147_483_647): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new AdminAuthError("invalid-input", `${name} 须为 1–${max} 的整数`)
  }
  return value
}

export function timestamp(value: unknown): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new AdminAuthError("invalid-input", "时间必须是有效的时间字符串")
  }
  return new Date(value).toISOString()
}

export function eq(field: string, value: string | boolean): RelationalFilter {
  return { type: "eq", field, value }
}

export function and(...conditions: RelationalFilter[]): RelationalFilter {
  return { type: "and", conditions }
}
