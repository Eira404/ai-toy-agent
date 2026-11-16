import { StorageError } from "./error.js"

const IDENTITY_RE = /^[a-z][a-z0-9_-]*$/

/**
 * 校验一种存储类别或实例名称。
 *
 * @param value 待校验的类别或名称。
 * @param field 错误信息中显示的字段名。
 * @returns 合法时无返回值。
 * @throws {StorageError} 名称为空或不符合约定时抛出。
 */
export function assertStorageIdentity(value: string, field: "kind" | "name"): void {
  if (!IDENTITY_RE.test(value)) {
    throw new StorageError("invalid-identity", `${field} '${value}' 必须匹配 ${IDENTITY_RE}`)
  }
}

/** 组合类型与名称，避免同名的不同存储能力相互覆盖。 */
export function storageIdentityKey(kind: string, name: string): string {
  // JSON 元组编码避免分隔符出现在名称中造成键冲突。
  return JSON.stringify([kind, name])
}
