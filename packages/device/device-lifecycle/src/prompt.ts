import type { PromptSection } from "toy-agent-loop"
import { parseDevicePresets } from "./parse.js"
import type { PersonaPrompt } from "./types.js"

/** 本地人设目录：把玩偶人设名映射成完整的玩偶人设 system prompt。 */
export const PERSONA_CATALOG: readonly PersonaPrompt[] = [
  {
    id: "dinosaur",
    label: "小恐龙",
    systemPrompt:
      "你是一只可爱的玩偶小恐龙，性格活泼、勇敢又有点憨憨的。说话充满童趣和想象力，喜欢用拟声词（比如「嗷呜」「咔咔」），回答时多用鼓励和夸张的比喻。",
  },
  {
    id: "rabbit",
    label: "小兔子",
    systemPrompt:
      "你是一只温柔的玩偶小兔子，性格软萌、细腻、善解人意。说话轻声细语，多倾听和安慰，喜欢用「软软的」「暖暖的」这类词。",
  },
  {
    id: "bear",
    label: "小熊",
    systemPrompt:
      "你是一只憨厚的玩偶小熊，性格温暖、可靠、有耐心。说话稳重亲切，喜欢讲小道理、给大大的拥抱式的鼓励。",
  },
  {
    id: "cat",
    label: "小猫",
    systemPrompt:
      "你是一只机灵的玩偶小猫，性格好奇、俏皮、爱撒娇。说话轻快简短，喜欢用「喵」和灵动的比喻。",
  },
]

/** 把玩偶人设文本映射成 system prompt；命中目录用目录文本，未命中用原文兜底。 */
export function renderPersona(persona: string | null): string | null {
  if (persona === null) {
    return null
  }
  const trimmed = persona.trim()
  if (trimmed.length === 0) {
    return null
  }
  const entry = PERSONA_CATALOG.find((item) => item.label === trimmed)
  if (entry !== undefined) {
    return entry.systemPrompt
  }
  return `你是用户的玩偶伙伴，人设如下：${trimmed}。请始终以这个人设的口吻与用户交流。`
}

/** 从 session payload 渲染「人设 + 年龄」两段 system prompt；无预设时返回空串。 */
export function renderDeviceSection(payload: unknown): string {
  const presets = parseDevicePresets(payload)
  if (presets === null) {
    return ""
  }
  const parts: string[] = []
  const persona = renderPersona(presets.personaPreset)
  if (persona !== null) {
    parts.push(["## 玩偶人设", persona].join("\n"))
  }
  if (presets.ageGrade !== null) {
    parts.push(["## 面向年龄段", presets.ageGrade.description].join("\n"))
  }
  return parts.join("\n\n")
}

/** 生成注册到 system prompt 的设备片段。 */
export function deviceSection(): PromptSection {
  return {
    name: "device-persona",
    order: 100,
    render: ({ session }) => renderDeviceSection(session.payload),
  }
}
