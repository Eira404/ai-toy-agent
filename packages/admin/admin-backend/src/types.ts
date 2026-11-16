import type { AdminBinding } from "toy-admin"

/** 当前 JSON HTTP 适配器支持的方法；不表示 SSE/WebSocket 已实现。 */
export type AdminHttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE"
export type AdminHttpInputSource = "body" | "query" | "request"

/** httpBinding 的输入；字段提示和运行时校验均由本包提供。 */
export interface AdminHttpBindingOptions {
  readonly method: AdminHttpMethod
  /** 相对路径，不含统一挂载前缀（默认 /admin）。 */
  readonly path: string
  /** 默认 GET=query，其余=body；request 显式交付 {params, query, body}。 */
  readonly inputSource?: AdminHttpInputSource
  /** 当前仅支持 json；SSE 不能通过修改此值启用。 */
  readonly responseMode?: "json"
}

/** 已补全默认值、校验并冻结的绑定，可直接放入 toy-admin 的 bindings。 */
export type AdminHttpBinding = AdminBinding & {
  readonly transport: "http"
  readonly method: AdminHttpMethod
  readonly path: string
  readonly inputSource: AdminHttpInputSource
  readonly responseMode: "json"
}

/** 供宿主诊断未挂载的绑定，不包含处理函数或请求数据。 */
export interface AdminBindingIssue {
  readonly operationName: string
  readonly registrationId: string
  readonly bindingIndex: number
  readonly code: "invalid-binding" | "unsupported-result" | "route-conflict"
  readonly message: string
}

/** 管理员 HTTP 后端配置。 */
export interface AdminBackendConfig {
  /** 统一管理前缀，默认 /admin；账号端点与能力路由都挂在其下。 */
  readonly mountPath?: string
}
