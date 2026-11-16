export const EMOTION_CATALOG = [
  {
    id: "neutral",
    name: "中性",
    description: "用户没有表达明显情绪，只是在正常陈述或提问。",
    examples: "“现在电量是多少”“解释一下这个概念”",
  },
  {
    id: "happy",
    name: "开心",
    description: "表现出高兴、满足、兴奋或庆祝。",
    examples: "“我终于通过考试了，太开心了”",
  },
  {
    id: "sad",
    name: "悲伤",
    description: "表现出难过、失落、沮丧或想哭。",
    examples: "“考试没通过，我很难过”",
  },
  {
    id: "anxious",
    name: "焦虑",
    description: "表现出担心、不安、紧张或反复忧虑。",
    examples: "“我一直担心明天的面试”",
  },
  {
    id: "angry",
    name: "愤怒",
    description: "表现出生气、恼怒、敌意或强烈不满。",
    examples: "“这个程序又崩了，真气死我了”",
  },
  {
    id: "afraid",
    name: "害怕",
    description: "表现出恐惧、害怕危险或对某件事产生畏惧。",
    examples: "“我很害怕手术会出问题”",
  },
  {
    id: "frustrated",
    name: "挫败",
    description: "因反复失败、受阻或无法完成目标而感到烦躁和无力。",
    examples: "“我已经试了十次，还是运行不了”",
  },
  {
    id: "confused",
    name: "困惑",
    description: "表现出不理解、迷茫或无法判断。",
    examples: "“我完全看不懂这段代码在做什么”",
  },
  {
    id: "lonely",
    name: "孤独",
    description: "表现出缺少陪伴、被忽视或与他人失去连接。",
    examples: "“没人愿意听我说话，我觉得很孤独”",
  },
  {
    id: "distressed",
    name: "痛苦",
    description: "表现出强烈心理痛苦、绝望、崩溃或无法承受。",
    examples: "“我真的撑不下去了”“感觉一切都没有意义”",
  },
  {
    id: "disappointed",
    name: "失望",
    description: "结果未达到预期，表现出遗憾或失望。",
    examples: "“准备了这么久还是失败了，太失望了”",
  },
  {
    id: "surprised",
    name: "惊讶",
    description: "对意外结果表现出惊讶或不可置信。",
    examples: "“居然这么快就完成了？”",
  },
  {
    id: "unknown",
    name: "无法判断",
    description: "文本过短、存在歧义或没有足够证据判断情绪。",
    examples: "“哦”“行吧”",
  },
] as const

export type EmotionId = (typeof EMOTION_CATALOG)[number]["id"]
