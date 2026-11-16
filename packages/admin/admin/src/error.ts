import { AdminAuthError } from "toy-admin-auth"
import type { AdminExecutionState } from "./types.js"

export type AdminErrorCode =
  | "invalid-definition"
  | "invalid-schema"
  | "duplicate-operation"
  | "invalid-input"
  | "invalid-output"
  | "unauthenticated"
  | "forbidden"
  | "operation-not-found"
  | "operation-unavailable"
  | "source-not-ready"
  | "schema-mismatch"
  | "busy"
  | "timeout"
  | "cancelled"
  | "execution-failed"
  | "audit-unavailable"
  | "audit-incomplete"
  /** 业务资源当前处于冲突状态（如同一记忆空间已有 Daily 在运行）。 */
  | "conflict"

/**
 * 可交给适配层的稳定错误。message 不包含业务原始异常/输入。
 * executionState 指业务执行状态，尤其 timeout/audit-incomplete 不能被解读为业务回滚。
 */
export class AdminError extends Error {
  readonly executionId: string | undefined
  readonly executionState: AdminExecutionState

  constructor(
    readonly code: AdminErrorCode,
    message: string,
    options: {
      executionId?: string
      executionState?: AdminExecutionState
      cause?: unknown
    } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = "AdminError"
    this.executionId = options.executionId
    this.executionState = options.executionState ?? "not-started"
  }
}

/** 保留可预期鉴权错误，将其他异常安全化；底层原因只在非枚举 cause 中供开发者诊断。 */
export function normalizeError(
  error: unknown,
  executionId: string,
  state: AdminExecutionState,
): AdminError {
  if (error instanceof AdminError) {
    return new AdminError(error.code, error.message, {
      executionId,
      executionState: state,
      cause: error,
    })
  }
  if (
    error instanceof AdminAuthError &&
    (error.code === "unauthenticated" || error.code === "forbidden")
  ) {
    return new AdminError(error.code, "管理员身份无效或没有操作权限", {
      executionId,
      executionState: state,
      cause: error,
    })
  }
  return new AdminError("execution-failed", "管理调用未成功完成", {
    executionId,
    executionState: state,
    cause: error,
  })
}
