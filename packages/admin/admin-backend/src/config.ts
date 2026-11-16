import { AdminError } from "toy-admin"
import type { AdminBackendConfig } from "./types.js"
import { normalizeAdminPath } from "./binding.js"

export function resolveAdminBackendConfig(config: AdminBackendConfig = {}) {
  if (config === null || typeof config !== "object" || Array.isArray(config)) {
    throw new AdminError("invalid-input", "配置必须是对象")
  }
  try {
    return { mountPath: normalizeAdminPath(config.mountPath ?? "/admin", "mountPath", false) }
  } catch (cause) {
    throw new AdminError("invalid-input", "mountPath 必须是无参数的合法相对路径", { cause })
  }
}

export type ResolvedAdminBackendConfig = ReturnType<typeof resolveAdminBackendConfig>
