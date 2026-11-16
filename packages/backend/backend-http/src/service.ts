import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http"
import { Service, type Context } from "cordis"
import { resolveHttpServerConfig, type HttpServerConfig } from "./config.js"
import { compilePath, matchSegments, type Route } from "./router.js"
import type { HttpContext, HttpHandler, SseHandler } from "./types.js"

declare module "cordis" {
  interface Context {
    http: HttpServer
  }
}

/**
 * 后端 HTTP 服务：持有路由表并监听本地地址。业务插件（如 `toy-backend-agent`）通过
 * `route`/`get`/`post` 注册路径，即可通过 `http://127.0.0.1:port/...` 调用。
 */
export class HttpServer extends Service {
  private readonly config: { readonly host: string; readonly port: number }
  private readonly routes: Route[] = []
  private httpServer: Server | undefined
  private resolveReady: (() => void) | undefined

  /** 在 'listening' 事件后 resolve；测试或宿主可先 `await` 它再发起请求。 */
  readonly ready: Promise<void>

  constructor(ctx: Context, config: HttpServerConfig = {}) {
    super(ctx, "http")
    this.config = resolveHttpServerConfig(config)
    this.ready = new Promise((resolve) => {
      this.resolveReady = resolve
    })

    ctx.effect(() => {
      const server = createServer((req, res) => {
        void this.handle(req, res)
      })
      this.httpServer = server
      server.listen(this.config.port, this.config.host, () => this.resolveReady?.())
      return () => {
        this.httpServer = undefined
        server.close()
        server.closeAllConnections()
      }
    }, "http.listen")
  }

  /** 注册路由并返回注销函数。 */
  route(method: string, path: string, handler: HttpHandler): () => void {
    if (typeof handler !== "function") {
      throw new TypeError("handler 必须是函数")
    }
    const route: Route = {
      method: method.toUpperCase(),
      segments: compilePath(path),
      kind: "json",
      handler,
    }
    this.routes.push(route)
    let released = false
    return () => {
      if (!released) {
        released = true
        const index = this.routes.indexOf(route)
        if (index >= 0) {
          this.routes.splice(index, 1)
        }
      }
    }
  }

  get(path: string, handler: HttpHandler): () => void {
    return this.route("GET", path, handler)
  }

  post(path: string, handler: HttpHandler): () => void {
    return this.route("POST", path, handler)
  }

  put(path: string, handler: HttpHandler): () => void {
    return this.route("PUT", path, handler)
  }

  delete(path: string, handler: HttpHandler): () => void {
    return this.route("DELETE", path, handler)
  }

  /** 注册一个 SSE 流式路由（POST）；handler 用 `emit` 逐事件写出。 */
  sse(path: string, handler: SseHandler): () => void {
    if (typeof handler !== "function") {
      throw new TypeError("handler 必须是函数")
    }
    const route: Route = {
      method: "POST",
      segments: compilePath(path),
      kind: "sse",
      handler,
    }
    this.routes.push(route)
    let released = false
    return () => {
      if (!released) {
        released = true
        const index = this.routes.indexOf(route)
        if (index >= 0) {
          this.routes.splice(index, 1)
        }
      }
    }
  }

  /** 返回实际绑定地址；未监听时返回 undefined。 */
  address(): { readonly host: string; readonly port: number } | undefined {
    const address = this.httpServer?.address()
    if (address === null || address === undefined || typeof address === "string") {
      return undefined
    }
    return { host: address.address, port: address.port }
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const controller = new AbortController()
    res.on("close", () => controller.abort())
    try {
      const url = new URL(req.url ?? "/", "http://localhost")
      const method = (req.method ?? "GET").toUpperCase()
      const matched = this.matchRoute(method, compilePath(url.pathname))
      if (matched === undefined) {
        this.writeJson(res, 404, {
          ok: false,
          error: { code: "not-found", message: `没有匹配的路由：${method} ${url.pathname}` },
        })
        return
      }
      const context: HttpContext = {
        method,
        path: url.pathname,
        query: url.searchParams,
        params: matched.params,
        headers: req.headers,
        body: await readJsonBody(req),
        signal: controller.signal,
      }
      if (matched.route.kind === "sse") {
        await this.handleSse(res, context, matched.route.handler as SseHandler)
      } else {
        const data = await (matched.route.handler as HttpHandler)(context)
        this.writeJson(res, 200, { ok: true, data: data ?? null })
      }
    } catch (error) {
      const { status, code, message } = normalizeHttpError(error)
      this.writeJson(res, status, { ok: false, error: { code, message } })
    }
  }

  /** 以 SSE 形式执行 handler，逐事件写出，handler resolve 后结束流。 */
  private async handleSse(res: ServerResponse, ctx: HttpContext, handler: SseHandler): Promise<void> {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    })
    const emit = (event: unknown): void => {
      if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify(event ?? null)}\n\n`)
      }
    }
    try {
      await handler(ctx, emit)
    } catch (error) {
      const { code, message } = normalizeHttpError(error)
      if (!res.writableEnded) {
        res.write(`event: error\ndata: ${JSON.stringify({ code, message })}\n\n`)
      }
    } finally {
      res.end()
    }
  }

  private matchRoute(
    method: string,
    segments: readonly string[],
  ): { readonly route: Route; readonly params: Record<string, string> } | undefined {
    for (const route of this.routes) {
      if (route.method !== method) {
        continue
      }
      const params = matchSegments(route.segments, segments)
      if (params !== null) {
        return { route, params }
      }
    }
    return undefined
  }

  private writeJson(res: ServerResponse, status: number, value: unknown): void {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8" })
    res.end(JSON.stringify(value))
  }
}

/** 读取并解析 JSON 请求体；空请求体返回 undefined，非法 JSON 抛 `invalid-json`。 */
async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    chunks.push(chunk)
  }
  const raw = Buffer.concat(chunks).toString("utf8")
  if (raw.trim().length === 0) {
    return undefined
  }
  try {
    return JSON.parse(raw)
  } catch {
    throw Object.assign(new Error("请求体必须是有效 JSON"), { code: "invalid-json" })
  }
}

/** 把业务错误归一化为 HTTP 状态、稳定错误码和可读消息。 */
function normalizeHttpError(error: unknown): { status: number; code: string; message: string } {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { code: unknown }).code)
      : "INTERNAL"
  const message = error instanceof Error ? error.message : String(error)
  return { status: STATUS_BY_CODE[code] ?? 500, code, message }
}

const STATUS_BY_CODE: Record<string, number> = {
  "invalid-input": 400,
  "invalid-json": 400,
  "invalid-state": 409,
  "active-session-exists": 409,
  "not-resident": 404,
  "turn-not-found": 404,
  "session-not-found": 404,
  "user-not-found": 404,
  "device-not-found": 404,
  "user-exists": 409,
  "device-exists": 409,
  "storage-unavailable": 503,
  "source-not-found": 503,
  "source-not-ready": 503,
  "NO_RUNNER": 503,
  "INVALID_REQUEST": 400,
  "LLM_ERROR": 502,
  "ABORTED": 409,
  "MAX_STEPS": 422,
  // toy-admin / toy-admin-auth 错误码
  "unauthenticated": 401,
  "invalid-credentials": 401,
  "forbidden": 403,
  "operation-not-found": 404,
  "admin-not-found": 404,
  "admin-exists": 409,
  "last-superadmin": 409,
  "already-initialized": 409,
  "duplicate-operation": 409,
  "operation-unavailable": 409,
  "cancelled": 409,
  "conflict": 409,
  "busy": 429,
  "rate-limited": 429,
  "auth-busy": 429,
  "timeout": 504,
  "audit-unavailable": 503,
  "transactions-required": 500,
  "schema-mismatch": 500,
  "invalid-definition": 500,
  "invalid-schema": 500,
  "invalid-output": 500,
  "execution-failed": 500,
  "audit-incomplete": 500,
}

export default HttpServer
