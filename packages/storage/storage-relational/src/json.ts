/** 所有 adapter 都必须能够无损处理的 JSON 数据。 */
export type JsonPrimitive = string | number | boolean | null
/** 支持递归对象和数组的只读 JSON 值。 */
export type JsonValue = JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue }

/** 一行结构化数据。 */
export type RelationalRecord = Readonly<Record<string, JsonValue>>

/**
 * 检查一个值是否是有限、无循环且不带自定义原型的 JSON 值。
 *
 * @param value 来自业务代码或外部输入的未知值。
 * @returns true 表示该值能够被所有 adapter 按统一 JSON 语义处理。
 */
export function isJsonValue(value: unknown): value is JsonValue {
  // 每次顶层调用使用独立祖先集合，避免不同校验任务相互污染。
  return visitJsonValue(value, new WeakSet<object>())
}

/**
 * 递归检查 JSON 值，并使用祖先集合识别真正的循环引用。
 *
 * @param value 当前递归节点。
 * @param ancestors 当前递归路径中的对象集合。
 * @returns 当前节点及全部后代都能表示为 JSON 时返回 true。
 */
function visitJsonValue(value: unknown, ancestors: WeakSet<object>): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return true
  }
  if (typeof value === "number") {
    return Number.isFinite(value)
  }
  if (typeof value !== "object") {
    return false
  }
  if (ancestors.has(value)) {
    // 循环结构无法由 JSON 和数据库 json/jsonb 字段无损表达。
    return false
  }

  // 只在当前递归路径保留对象；共享但不循环的子对象仍然合法。
  ancestors.add(value)
  try {
    if (Array.isArray(value)) {
      return value.every((entry) => visitJsonValue(entry, ancestors))
    }

    const prototype = Object.getPrototypeOf(value) as object | null
    if (prototype !== Object.prototype && prototype !== null) {
      // Date、Map 和类实例必须先由业务层转换为明确的 JSON 表示。
      return false
    }
    return Object.values(value).every((entry) => visitJsonValue(entry, ancestors))
  } finally {
    ancestors.delete(value)
  }
}
