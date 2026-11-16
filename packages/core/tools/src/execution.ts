import type { ToolCallBlock } from "toy-llm"
import type { RegisteredTool } from "./schema.js"
import type {
  ToolErrorPhase,
  ToolExecutionContext,
  ToolExecutionResult,
  ToolJsonValue,
  ToolScope,
} from "./types.js"

/**
 * 执行工具快照内的一个调用。
 *
 * @param tool 快照中的注册项。缺失时返回解析阶段错误。
 * @param call 模型工具调用。
 * @param scope 快照创建时记录的身份和轮次。
 * @param signal 本轮取消信号。
 * @returns 可发送给模型的工具结果。
 */
export async function executeTool(
  tool: RegisteredTool | undefined,
  call: ToolCallBlock,
  scope: ToolScope,
  signal?: AbortSignal,
): Promise<ToolExecutionResult> {
  signal?.throwIfAborted()
  if (tool === undefined) {
    return failure(call.id, "resolution", `工具 '${call.name}' 在本次请求中不可用`)
  }

  let parsed: unknown
  try {
    parsed = call.arguments.trim().length === 0 ? {} : JSON.parse(call.arguments)
  } catch {
    return failure(call.id, "parse", "工具参数必须是有效 JSON")
  }
  if (!tool.validateArguments(parsed)) {
    const details = tool.validateArguments.errors
      ?.map(({ instancePath, message, keyword }) => `${instancePath || "/"} ${message ?? keyword}`)
      .join("，")
    return failure(call.id, "validation", details || "工具参数不符合 Schema")
  }

  let recorded: ToolJsonValue | undefined
  const context: ToolExecutionContext = {
    ...scope,
    toolCallId: call.id,
    ...(signal === undefined ? {} : { signal }),
    record: (data) => {
      recorded = data
    },
  }

  try {
    const value = await tool.execute(parsed, context)
    signal?.throwIfAborted()
    return {
      toolCallId: call.id,
      isError: false,
      content: typeof value === "string" ? value : (JSON.stringify(value) ?? "null"),
      ...(recorded === undefined ? {} : { data: recorded }),
    }
  } catch {
    // 停止整个 Turn 的信号由上游处理，普通执行错误转成模型可见的工具结果。
    signal?.throwIfAborted()
    return {
      ...failure(call.id, "execution", `工具 '${call.name}' 执行失败`),
      ...(recorded === undefined ? {} : { data: recorded }),
    }
  }
}

function failure(toolCallId: string, phase: ToolErrorPhase, message: string): ToolExecutionResult {
  return { toolCallId, content: message, isError: true, error: { phase, message } }
}
