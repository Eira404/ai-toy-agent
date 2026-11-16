import type { AdminIdentity, AdminRole } from "toy-admin-auth"
import type { JsonValue } from "toy-storage-relational"

/** JSON Schema draft-07；只支持同步校验和定义内部的 # 引用。 */
export type AdminJsonSchema = boolean | Readonly<Record<string, JsonValue>>

/** backend 自己解释的绑定。总包仅要求它是 JSON 对象并含 transport，不匹配 URL 或协议帧。 */
export interface AdminBinding {
  readonly transport: string
  readonly [key: string]: JsonValue
}

/** 提供给 execute/authorize/audit 的可信调用上下文，不含原始 Token。 */
export interface AdminExecutionContext {
  /** 总包生成；关联审计和等待超时后的最终执行结果。 */
  readonly executionId: string
  /** 可信适配层生成的关联 ID，省略时采用 executionId，不是幂等键。 */
  readonly requestId: string
  readonly operationName: string
  /** 当次认证的只读快照；不能代替未来请求的 Token 校验。 */
  readonly identity: AdminIdentity
  /** 仅用于当前调用；独立任务或返回后的订阅不能直接复用此信号。 */
  readonly signal: AbortSignal
}

/**
 * 由可信业务插件注册的管理能力。示例：ctx.effect(() => ctx.admin.register({...}))。
 * I/O 泛型表达调用约定；运行时仍以 input/output Schema 为准。
 */
export interface AdminOperationDefinition<I = unknown, O = unknown> {
  readonly name: string
  readonly description: string
  /** 严格白名单，无隐式超级管理员绕过；command 不可授予 viewer。 */
  readonly roles: readonly AdminRole[]
  readonly kind: "query" | "command"
  readonly bindings: readonly AdminBinding[]
  readonly input: AdminJsonSchema
  readonly output?: AdminJsonSchema
  /** 默认 value，须为 JSON（undefined 归一 null）；opaque 原样交付事件源/业务句柄，不能指定 output。 */
  readonly resultKind?: "value" | "opaque"
  /** 等待期限（包含前置校验和审计），不得超过总包 maxTimeoutMs。 */
  readonly timeoutMs?: number
  /** 可额外限制目标资源。必须无副作用；返回 false 或抛错时不执行。 */
  authorize?(input: I, context: AdminExecutionContext): boolean | void | Promise<boolean | void>
  /** 只返回明确可记录的安全摘要；默认不记录输入/输出，敏感键和过大摘要会被拒绝。 */
  audit?(input: I, context: AdminExecutionContext): JsonValue | Promise<JsonValue>
  execute(input: I, context: AdminExecutionContext): O | Promise<O>
}

/** 可供管理端展示的冻结元数据；没有任何回调或原始内部引用。 */
export interface AdminOperationDescription {
  readonly registrationId: string
  readonly name: string
  readonly description: string
  readonly roles: readonly AdminRole[]
  readonly kind: "query" | "command"
  readonly bindings: readonly AdminBinding[]
  readonly input: AdminJsonSchema
  readonly output?: AdminJsonSchema
  readonly resultKind: "value" | "opaque"
  readonly timeoutMs: number
}

/** 完整注册表供可信 backend 同步路由；客户端应使用 listOperations 的权限过滤版本。 */
export interface AdminRegistrySnapshot {
  readonly revision: number
  readonly operations: readonly AdminOperationDescription[]
}

/** 外部仅提交凭据与业务 DTO，不能提交可信 identity。 */
export interface AdminExecuteOptions<I = unknown> {
  readonly token: string
  readonly input: I
  readonly requestId?: string
  readonly signal?: AbortSignal
  /** backend 将 handler 固定到注册代次，避免旧 URL 命中新定义。 */
  readonly expectedRegistrationId?: string
}

export interface AdminWaitOptions {
  readonly signal?: AbortSignal
  /** 只停止等待，不停止仍在执行的业务方法。 */
  readonly timeoutMs?: number
}

/** 总包配置；数据库连接及 Schema 合并由宿主负责。 */
export interface AdminConfig {
  readonly sourceName?: string
  /** 包含前置认证/校验的在途调用上限，默认 16；超出立即拒绝。 */
  readonly maxConcurrentExecutions?: number
  /** 默认 30 秒；操作可单独声明。 */
  readonly defaultTimeoutMs?: number
  /** 单次调用等待期限上限，默认 5 分钟。 */
  readonly maxTimeoutMs?: number
  /** 输入及普通输出的 JSON 大小上限，默认 1 MiB。 */
  readonly maxDataBytes?: number
  /** 绑定和 Schema 元数据大小上限，默认 256 KiB。 */
  readonly maxDefinitionBytes?: number
  /** 默认 4096 字节；摘要不能包含 password/token/secret 等敏感键。 */
  readonly maxAuditBytes?: number
  readonly now?: () => string
}

/** 表示业务 execute 是否实际开始/结束；未知不等于失败或已取消。 */
export type AdminExecutionState = "not-started" | "unknown" | "succeeded" | "failed"
export type AdminWaitStatus = "waiting" | "completed" | "timeout" | "cancelled"
