import type { LifecycleResult } from "toy-lifecycle"
import type { SessionRecord } from "toy-session-storage"
import type { SessionPayload, SessionWorkflowOutput } from "./types.js"

/** 归一化无输出的节点，SessionData 会在写入边界校验完整 payload 的 JSON 格式。 */
export function workflowOutput(result: LifecycleResult): SessionWorkflowOutput {
  return Object.fromEntries(
    Object.entries(result.data).map(([name, value]) => [name, value ?? null]),
  ) as SessionWorkflowOutput
}

/** 保存收尾输出时保留创建输入和前处理结果，也兼容由底层 API 创建的旧 payload。 */
export function closingPayload(
  session: SessionRecord,
  postprocessing: SessionWorkflowOutput,
): SessionPayload {
  const { payload } = session
  if (isSessionPayload(payload)) {
    return { ...payload, postprocessing }
  }
  return {
    kind: "toy-session",
    initial: payload,
    initialVersion: session.version,
    preprocessing: {},
    postprocessing,
  }
}

function isSessionPayload(payload: SessionRecord["payload"]): payload is SessionPayload {
  return (
    typeof payload === "object" &&
    "kind" in payload &&
    payload.kind === "toy-session" &&
    "initial" in payload &&
    "preprocessing" in payload
  )
}
