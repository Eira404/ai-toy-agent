/** 可在 adapter 之间以 JSON 表达的值，数值必须有限。 */
export type JsonValue = null | string | number | boolean | readonly JsonValue[] | JsonObject

/** payload 的顶层对象，允许嵌套对象、数组和 null。 */
export interface JsonObject {
  readonly [key: string]: JsonValue
}

/** 识别普通对象，兼容由 Object.create(null) 创建的字典。 */
export function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object") {
    return false
  }
  const prototype: unknown = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/** 校验 payload 能用 JSON 表达，包含对嵌套值和循环引用的检查。 */
export function isJsonObject(value: unknown): value is JsonObject {
  return isPlainRecord(value) && isJsonValue(value, new WeakSet<object>())
}

function isJsonValue(value: unknown, ancestors: WeakSet<object>): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return true
  }
  if (typeof value === "number") {
    return Number.isFinite(value)
  }
  if ((!isPlainRecord(value) && !Array.isArray(value)) || ancestors.has(value)) {
    return false
  }

  // 只追踪当前递归路径，允许两个属性引用同一个普通子对象。
  ancestors.add(value)
  try {
    const entries: Iterable<unknown> = Array.isArray(value) ? value : Object.values(value)
    for (const entry of entries) {
      if (!isJsonValue(entry, ancestors)) {
        return false
      }
    }
    return true
  } finally {
    ancestors.delete(value)
  }
}
