import { Ajv, type ValidateFunction } from "ajv"
import { ToolError } from "./error.js"
import type { ToolDefinition } from "./types.js"

/** 预编译后的定义，注册或卸载全局工具时，已有快照可以继续使用。 */
export interface RegisteredTool extends ToolDefinition {
  readonly validateArguments: ValidateFunction
}

/** 注册和执行共用同一份参数定义，Ajv 保持输入原值。 */
export class ToolSchemaCompiler {
  private readonly compiler = new Ajv({ addUsedSchema: false, allErrors: true })

  /**
   * 校验工具名称和参数 Schema，并编译参数校验器。
   *
   * @param definition 业务插件提供的工具。
   * @returns 与调用方 Schema 对象隔离的注册项。
   */
  compile(definition: ToolDefinition): RegisteredTool {
    const name = definition.name.trim()
    if (!/^[a-zA-Z_][a-zA-Z0-9_-]{0,63}$/.test(name) || typeof definition.execute !== "function") {
      throw new ToolError("工具需要合法名称和执行函数", "INVALID_TOOL")
    }
    try {
      const parameters = structuredClone(definition.parameters)
      if (parameters.type !== "object" || parameters.$async === true) {
        throw new ToolError(`工具 '${name}' 需要同步的 object 参数 Schema`, "INVALID_SCHEMA")
      }
      const validateArguments = this.compiler.compile(parameters)
      return {
        name,
        description: definition.description,
        parameters,
        validateArguments,
        execute: definition.execute.bind(definition),
        ...(definition.isAvailable === undefined
          ? {}
          : { isAvailable: definition.isAvailable.bind(definition) }),
      }
    } catch (error) {
      if (error instanceof ToolError) {
        throw error
      }
      throw new ToolError(`工具 '${name}' 的参数 Schema 无效`, "INVALID_SCHEMA", { cause: error })
    }
  }
}
