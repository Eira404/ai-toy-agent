import { Ajv, type ValidateFunction } from "ajv"
import type { JsonValue } from "toy-storage-relational"
import { AdminError, type AdminErrorCode } from "./error.js"
import type { AdminJsonSchema } from "./types.js"

export function objectInput(value: unknown, code: AdminErrorCode = "invalid-input"): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new AdminError(code, "参数必须是对象")
  }
}

export function text(
  value: unknown,
  label: string,
  code: AdminErrorCode = "invalid-input",
  max = 128,
): string {
  if (typeof value !== "string" || value.length > max || value.trim().length === 0) {
    throw new AdminError(code, `${label} 必须是非空且长度受限的字符串`)
  }
  return value.trim()
}

export function positive(value: unknown, label: string): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > 2_147_483_647
  ) {
    throw new AdminError("invalid-input", `${label} 必须是正安全整数，且不超过 2147483647`)
  }
  return value
}

/** 冻结与调用方隔离的元数据/DTO，不冻结原始网络对象或 AbortSignal。 */
export function freezeDeep<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value)) {
      freezeDeep(child)
    }
  }
  return value
}

/** 拒绝循环、非有限数、类实例、getter、稀疏数组和会被 JSON 静默丢弃的属性。 */
function validJson(value: unknown, ancestors = new Set<object>(), depth = 0): value is JsonValue {
  if (depth > 64) {
    return false
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return true
  }
  if (typeof value === "number") {
    return Number.isFinite(value)
  }
  if (typeof value !== "object" || ancestors.has(value)) {
    return false
  }
  const array = Array.isArray(value)
  if (
    !array &&
    Object.getPrototypeOf(value) !== Object.prototype &&
    Object.getPrototypeOf(value) !== null
  ) {
    return false
  }
  ancestors.add(value)
  try {
    const keys = Reflect.ownKeys(value).filter((key) => !(array && key === "length"))
    if (
      array &&
      (keys.length !== value.length || keys.some((key, index) => key !== String(index)))
    ) {
      return false
    }
    return keys.every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!
      return (
        typeof key === "string" &&
        descriptor.enumerable === true &&
        "value" in descriptor &&
        validJson(descriptor.value, ancestors, depth + 1)
      )
    })
  } finally {
    ancestors.delete(value)
  }
}

/** 返回独立冻结的 JSON 快照；size 限制作用于 UTF-8 序列化结果。 */
export function jsonSnapshot(value: unknown, maxBytes: number, code: AdminErrorCode): JsonValue {
  if (!validJson(value)) {
    throw new AdminError(code, "数据必须是有限、无循环且无自定义行为的 JSON 值")
  }
  const encoded = JSON.stringify(value)
  if (Buffer.byteLength(encoded, "utf8") > maxBytes) {
    throw new AdminError(code, "JSON 数据超过大小上限")
  }
  return freezeDeep(JSON.parse(encoded) as JsonValue)
}

/** 只接受定义内部引用；禁止异步校验，避免未 await 的 Promise 被当作校验成功。 */
function checkSchema(value: JsonValue): void {
  if (value === null || typeof value !== "object") {
    return
  }
  for (const [key, child] of Object.entries(value)) {
    if (
      (key === "$ref" || key === "$dynamicRef" || key === "$recursiveRef") &&
      (typeof child !== "string" || !child.startsWith("#"))
    ) {
      throw new AdminError("invalid-schema", "Schema 引用仅支持本定义内的 # 引用")
    }
    if (key === "$async" && child !== false) {
      throw new AdminError("invalid-schema", "不支持异步 Schema")
    }
    checkSchema(child)
  }
}

/** 每个定义独立编译，避免全局 Schema ID 和卸载后的编译缓存互相影响。 */
export function compileSchema(
  schema: unknown,
  maxBytes: number,
): { schema: AdminJsonSchema; validate: ValidateFunction } {
  const snapshot = jsonSnapshot(schema, maxBytes, "invalid-schema")
  if (
    typeof snapshot !== "boolean" &&
    (snapshot === null || typeof snapshot !== "object" || Array.isArray(snapshot))
  ) {
    throw new AdminError("invalid-schema", "Schema 必须是对象或布尔值")
  }
  checkSchema(snapshot)
  try {
    const compiler = new Ajv({
      addUsedSchema: false,
      allErrors: false,
      ownProperties: true,
      coerceTypes: false,
      useDefaults: false,
      removeAdditional: false,
    })
    return {
      schema: snapshot as AdminJsonSchema,
      validate: compiler.compile(snapshot as AdminJsonSchema),
    }
  } catch (cause) {
    throw new AdminError("invalid-schema", "无法编译管理能力 Schema", { cause })
  }
}
