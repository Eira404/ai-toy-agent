import { AdminError, type AdminBinding } from "toy-admin"
import type {
  AdminHttpBinding,
  AdminHttpBindingOptions,
  AdminHttpInputSource,
  AdminHttpMethod,
} from "./types.js"

/** 当前适配器实际支持的方法；helper 和手写绑定共享该列表。 */
export const ADMIN_HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const
const FIELDS = new Set(["transport", "method", "path", "inputSource", "responseMode"])

/**
 * 定义管理 HTTP JSON 绑定。仅构造元数据，不创建路由或启动监听器。
 * @param options 请求方法、相对路径及明确的 DTO 来源。
 * @returns 默认值已补全的冻结绑定，可直接放入 ctx.admin.register 的 bindings。
 * @throws AdminError invalid-definition，不支持的方法、SSE 模式、非法路径或含糊输入映射。
 * @example bindings: [httpBinding({ method: "POST", path: "/example/double" })]
 */
export function httpBinding(options: AdminHttpBindingOptions): AdminHttpBinding {
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw invalid("HTTP 绑定配置必须是对象")
  }
  if (
    Object.keys(options).some(
      (key) =>
        key !== "method" && key !== "path" && key !== "inputSource" && key !== "responseMode",
    )
  ) {
    throw invalid("HTTP 绑定包含未知字段；请使用 method/path/inputSource/responseMode")
  }
  return parseHttpBinding({ ...options, transport: "http" } as AdminBinding)!
}

/** 非 HTTP 绑定交给其他适配器；HTTP 绑定无效时明确抛错，不能静默跳过。 */
export function parseHttpBinding(binding: AdminBinding): AdminHttpBinding | undefined {
  if (binding.transport !== "http") {
    return undefined
  }
  if (Object.keys(binding).some((key) => !FIELDS.has(key))) {
    throw invalid("HTTP 绑定包含未知字段")
  }
  if (!ADMIN_HTTP_METHODS.includes(binding.method as AdminHttpMethod)) {
    throw invalid("method 仅支持 GET、POST、PUT、PATCH、DELETE（区分大小写）")
  }
  if (binding.responseMode !== undefined && binding.responseMode !== "json") {
    throw invalid("当前管理 HTTP 适配器仅支持 JSON，尚不支持 SSE")
  }
  const method = binding.method as AdminHttpMethod
  const path = normalizeAdminPath(binding.path, "path")
  const inputSource = binding.inputSource ?? (method === "GET" ? "query" : "body")
  if (inputSource !== "body" && inputSource !== "query" && inputSource !== "request") {
    throw invalid("inputSource 必须是 body、query 或 request")
  }
  if (method === "GET" && inputSource === "body") {
    throw invalid("GET 不支持 body 输入，请使用 query 或 request")
  }
  if (path.split("/").some((segment) => segment.startsWith(":")) && inputSource !== "request") {
    throw invalid("路径参数需要 inputSource: request，防止路径参数被静默忽略")
  }
  return Object.freeze({
    transport: "http",
    method,
    path,
    inputSource: inputSource as AdminHttpInputSource,
    responseMode: "json",
  })
}

/** 只允许明确的路径段和 :parameter；URL、编码绕行、通配符、点段、空段均拒绝。 */
export function normalizeAdminPath(value: unknown, label: string, allowParameters = true): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 1024 ||
    !value.startsWith("/") ||
    value.includes("//")
  ) {
    throw invalid(`${label} 必须是以 / 开头、长度不超过 1024 的相对路径`)
  }
  const path = value.length > 1 && value.endsWith("/") ? value.slice(0, -1) : value
  if (path === "/") {
    return path
  }
  const names = new Set<string>()
  for (const segment of path.slice(1).split("/")) {
    if (segment.startsWith(":")) {
      if (
        !allowParameters ||
        !/^:[A-Za-z_][A-Za-z0-9_]*$/.test(segment) ||
        names.has(segment) ||
        [":__proto__", ":constructor", ":prototype"].includes(segment)
      ) {
        throw invalid(`${label} 的路径参数格式不合法或参数名重复`)
      }
      names.add(segment)
    } else if (!/^[A-Za-z0-9._~-]+$/.test(segment) || segment === "." || segment === "..") {
      throw invalid(`${label} 不允许协议/主机、空路径段、查询串、fragment、编码路径、通配符或点段`)
    }
  }
  return path
}

/** 相同方法下任一段可同时匹配则视为冲突，避免先注册者决定命中结果。 */
export function routesOverlap(
  left: { method: string; path: string },
  right: { method: string; path: string },
): boolean {
  if (left.method !== right.method) {
    return false
  }
  const a = left.path.split("/").filter(Boolean)
  const b = right.path.split("/").filter(Boolean)
  return (
    a.length === b.length &&
    a.every(
      (segment, index) =>
        segment === b[index] || segment.startsWith(":") || b[index]!.startsWith(":"),
    )
  )
}

function invalid(message: string): AdminError {
  return new AdminError("invalid-definition", message)
}
