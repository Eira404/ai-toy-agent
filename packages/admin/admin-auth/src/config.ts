import { AdminAuthError } from "./error.js"
import { objectInput, positive, text } from "./helpers.js"
import type { AdminAuthConfig } from "./types.js"

export function resolveConfig(config: AdminAuthConfig) {
  objectInput(config)
  if (config.now !== undefined && typeof config.now !== "function") {
    throw new AdminAuthError("invalid-input", "now 必须是函数")
  }
  return {
    sourceName: text(config.sourceName ?? "main", "sourceName"),
    sessionTtlMs: positive(config.sessionTtlMs ?? 8 * 60 * 60_000, "sessionTtlMs"),
    loginWindowMs: positive(config.loginWindowMs ?? 15 * 60_000, "loginWindowMs"),
    maxLoginAttempts: positive(config.maxLoginAttempts ?? 5, "maxLoginAttempts", 100),
    maxConcurrentPasswordOps: positive(
      config.maxConcurrentPasswordOps ?? 2,
      "maxConcurrentPasswordOps",
      16,
    ),
    now: config.now ?? (() => new Date().toISOString()),
  }
}
