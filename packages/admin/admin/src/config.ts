import { AdminError } from "./error.js"
import { objectInput, positive, text } from "./validation.js"
import type { AdminConfig } from "./types.js"

export function resolveConfig(config: AdminConfig) {
  objectInput(config)
  const maxTimeoutMs = positive(config.maxTimeoutMs ?? 300_000, "maxTimeoutMs")
  const defaultTimeoutMs = positive(config.defaultTimeoutMs ?? 30_000, "defaultTimeoutMs")
  if (
    defaultTimeoutMs > maxTimeoutMs ||
    (config.now !== undefined && typeof config.now !== "function")
  ) {
    throw new AdminError("invalid-input", "等待期限配置或时钟配置不合法")
  }
  return {
    sourceName: text(config.sourceName ?? "main", "sourceName"),
    maxConcurrentExecutions: positive(
      config.maxConcurrentExecutions ?? 16,
      "maxConcurrentExecutions",
    ),
    defaultTimeoutMs,
    maxTimeoutMs,
    maxDataBytes: positive(config.maxDataBytes ?? 1024 * 1024, "maxDataBytes"),
    maxDefinitionBytes: positive(config.maxDefinitionBytes ?? 256 * 1024, "maxDefinitionBytes"),
    maxAuditBytes: positive(config.maxAuditBytes ?? 4096, "maxAuditBytes"),
    now: config.now ?? (() => new Date().toISOString()),
  }
}

export type ResolvedAdminConfig = ReturnType<typeof resolveConfig>
