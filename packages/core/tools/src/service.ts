import { Service, type Context } from "cordis"
import type { LlmToolSchema } from "toy-llm"
import { ToolError } from "./error.js"
import { executeTool } from "./execution.js"
import { ToolSchemaCompiler, type RegisteredTool } from "./schema.js"
import type {
  BuiltinToolDeclaration,
  ResolvedToolSet,
  ToolDefinition,
  ToolResolutionContext,
} from "./types.js"

declare module "cordis" {
  interface Context {
    tools: ToolRegistry
  }
}

/** 挂载到 `ctx.tools` 的本地工具目录。 */
export class ToolRegistry extends Service {
  private readonly definitions = new Map<string, RegisteredTool>()
  private readonly builtinDefinitions = new Map<string, BuiltinToolDeclaration>()
  private readonly compiler = new ToolSchemaCompiler()

  constructor(ctx: Context) {
    super(ctx, "tools")
  }

  /**
   * 注册并编译一个本地工具。
   *
   * @param definition 工具名、描述、参数 Schema 和执行函数。
   * @returns 幂等注销函数。建议由注册工具的插件通过 `ctx.effect` 管理。
   */
  register(definition: ToolDefinition): () => void {
    const tool = this.compiler.compile(definition)
    if (this.definitions.has(tool.name)) {
      throw new ToolError(`工具 '${tool.name}' 已注册`, "DUPLICATE_TOOL")
    }
    this.definitions.set(tool.name, tool)
    return () => {
      if (this.definitions.get(tool.name) === tool) {
        this.definitions.delete(tool.name)
      }
    }
  }

  /**
   * 注册一个由模型供应商执行的内置工具（如 web_search），返回注销函数。
   * 内置工具没有本地 execute，仅当 Provider 声明支持（builtinTools）时才注入。
   */
  registerBuiltin(declaration: BuiltinToolDeclaration): () => void {
    const name = declaration.name.trim()
    if (name.length === 0) {
      throw new ToolError("内置工具名称不能为空", "INVALID_TOOL")
    }
    if (this.builtinDefinitions.has(name)) {
      throw new ToolError(`内置工具 '${name}' 已注册`, "DUPLICATE_TOOL")
    }
    const registered = Object.freeze({ ...declaration, name })
    this.builtinDefinitions.set(name, registered)
    return () => {
      if (this.builtinDefinitions.get(name) === registered) {
        this.builtinDefinitions.delete(name)
      }
    }
  }

  /**
   * 为一次模型请求解析工具，固定可见的声明和执行器。
   *
   * @param context 当前作用域、可选的 Turn payload 和模型路由能力。
   * @returns 将 `schemas` 发给模型，再用同一对象的 `execute` 处理模型返回的工具调用。
   */
  resolve(context: ToolResolutionContext): ResolvedToolSet {
    const { userId, deviceId, sessionId, turnId } = context.scope
    const scope = Object.freeze({ userId, deviceId, sessionId, turnId })
    const payload = context.payload ?? {}
    const definitions = new Map<string, RegisteredTool>()
    const schemas: LlmToolSchema[] = []
    if (context.providerCapabilities.functionTools) {
      for (const tool of this.definitions.values()) {
        if (tool.isAvailable?.(scope, payload) ?? true) {
          definitions.set(tool.name, tool)
          schemas.push(
            freeze({
              kind: "function",
              name: tool.name,
              description: tool.description,
              parameters: structuredClone(tool.parameters),
            }),
          )
        }
      }
    }
    // 内置工具由供应商执行：按 Provider 声明的 builtinTools 与业务 isAvailable 双重过滤。
    for (const tool of this.builtinDefinitions.values()) {
      if (context.providerCapabilities.builtinTools.includes(tool.name)) {
        if (tool.isAvailable?.(scope, payload) ?? true) {
          schemas.push(
            freeze({
              kind: "builtin",
              name: tool.name,
              description: tool.description,
              ...(tool.options === undefined ? {} : { options: structuredClone(tool.options) }),
            }),
          )
        }
      }
    }
    const snapshot: ResolvedToolSet = {
      schemas: Object.freeze(schemas),
      execute: (call, options) =>
        executeTool(definitions.get(call.name), call, scope, options?.signal),
    }
    return Object.freeze(snapshot)
  }
}

/** 冻结模型可见的 Schema 副本，保证它和快照里的校验器保持一致。 */
function freeze<T extends object>(value: T): T {
  Object.freeze(value)
  for (const item of Object.values(value)) {
    if (typeof item === "object" && item !== null && !Object.isFrozen(item)) {
      freeze(item)
    }
  }
  return value
}
