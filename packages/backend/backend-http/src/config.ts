/** 后端 HTTP 服务配置。 */
export interface HttpServerConfig {
  /** 监听地址，默认 `127.0.0.1`。 */
  readonly host?: string
  /** 监听端口；传 `0` 时由系统分配临时端口（测试用）。默认 3000。 */
  readonly port?: number
}

/** 填充默认值并校验后的配置。 */
export interface ResolvedHttpServerConfig {
  readonly host: string
  readonly port: number
}

/** 合并默认值并校验关键字段，供 `HttpServer` 构造函数调用。 */
export function resolveHttpServerConfig(
  config: HttpServerConfig = {},
): ResolvedHttpServerConfig {
  const host = config.host ?? "127.0.0.1"
  if (typeof host !== "string" || host.trim().length === 0) {
    throw new TypeError("host 必须是非空字符串")
  }
  const port = config.port ?? 3000
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new TypeError("port 必须是 0 到 65535 的整数")
  }
  return { host, port }
}
