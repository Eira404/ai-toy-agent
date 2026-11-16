import type { IncomingHttpHeaders } from "node:http"

/** 一次 HTTP 请求的归一化上下文，交给路由 handler。 */
export interface HttpContext {
  readonly method: string
  readonly path: string
  readonly query: URLSearchParams
  /** 路径参数，来自 `:name` 段。 */
  readonly params: Readonly<Record<string, string>>
  /** 请求头，键为小写（Node.js 归一化），值可能为 string 或 string[]。 */
  readonly headers: IncomingHttpHeaders
  /** 已解析的 JSON 请求体；无请求体时为 undefined。 */
  readonly body: unknown
  /** 请求/连接的中断信号；客户端断开时触发，可传给下游取消。 */
  readonly signal: AbortSignal
}

/** 路由处理器；返回值作为成功响应体（undefined 归一为 null），抛错由服务映射为错误响应。 */
export type HttpHandler = (ctx: HttpContext) => unknown | Promise<unknown>

/** SSE 流式处理器：用 `emit` 逐事件写出，返回的 Promise resolve 时结束流。 */
export type SseHandler = (ctx: HttpContext, emit: (event: unknown) => void) => void | Promise<void>
