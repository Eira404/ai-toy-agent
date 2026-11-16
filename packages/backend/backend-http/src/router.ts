import type { HttpHandler, SseHandler } from "./types.js"

/** 一条已注册的路由。 */
export interface Route {
  readonly method: string
  readonly segments: readonly string[]
  readonly kind: "json" | "sse"
  readonly handler: HttpHandler | SseHandler
}

/** 把路径拆成非空段，例如 `/agentBackend/getSession/:sessionId` → `["agentBackend","getSession",":sessionId"]`。 */
export function compilePath(path: string): string[] {
  return path.split("/").filter((segment) => segment.length > 0)
}

/** 按段匹配，`:` 前缀的段作为参数捕获；不匹配返回 null。 */
export function matchSegments(
  pattern: readonly string[],
  actual: readonly string[],
): Record<string, string> | null {
  if (pattern.length !== actual.length) {
    return null
  }
  const params: Record<string, string> = {}
  for (let index = 0; index < pattern.length; index += 1) {
    const expected = pattern[index]!
    const value = actual[index]!
    if (expected.startsWith(":")) {
      params[expected.slice(1)] = decodeURIComponent(value)
    } else if (expected !== value) {
      return null
    }
  }
  return params
}
