/**
 * 意图分类目录。
 *
 * 该数据属于 `toy-intent-analysis` 包，由 Prompt 和结果 Schema 共同使用；新增或修改意图时
 * 只维护此文件，禁止在 Agent 或 preprocessing 包中复制一份。
 */
export const INTENT_CATALOG = [
  {
    id: "chitchat",
    name: "闲聊",
    description: "用户主要在问候、寒暄或进行没有明确交付目标的轻量对话。",
    examples: "“你好”“你今天怎么样”“陪我聊会儿”",
  },
  {
    id: "fact-query",
    name: "事实查询",
    description: "用户希望获取一个相对明确的事实、定义、时间、地点或属性。",
    examples: "“牛顿出生于哪一年”“什么是光合作用”",
  },
  {
    id: "explanation",
    name: "解释说明",
    description: "用户希望理解某个概念、原理、原因或工作机制。",
    examples: "“为什么天空是蓝色的”“解释一下 RAG 的原理”",
  },
  {
    id: "education",
    name: "学习辅导",
    description: "用户处于课程、作业、考试或系统学习场景，希望获得教学式帮助。",
    examples: "“教我解这道方程”“讲解高中物理动量守恒”",
  },
  {
    id: "analysis",
    name: "分析",
    description: "用户希望对材料、现象、原因、趋势或关系进行深入分析。",
    examples: "“分析这家公司亏损的原因”“分析文章的中心思想”",
  },
  {
    id: "translation",
    name: "翻译",
    description: "用户希望把内容从一种语言转换为另一种语言。",
    examples: "“把这段英文翻译成中文”",
  },
  {
    id: "summarization",
    name: "总结摘要",
    description: "用户希望压缩、提炼或概括已有内容。",
    examples: "“总结这篇文章”“提炼会议纪要的重点”",
  },
  {
    id: "creation",
    name: "内容创作",
    description: "用户希望生成原本不存在的新内容。",
    examples: "“写一篇科幻小说”“生成一段产品宣传文案”",
  },
  {
    id: "rewriting",
    name: "改写编辑",
    description: "用户希望修改、润色、扩写、缩写或改变现有内容的表达方式。",
    examples: "“润色这段话”“改成正式语气”“把这篇文章缩短”",
  },
  {
    id: "calculation",
    name: "计算",
    description: "用户希望获得数学、数量、换算或公式计算结果。",
    examples: "“计算 123 乘 456”“100 美元约等于多少人民币”",
  },
  {
    id: "comparison",
    name: "比较",
    description: "用户希望比较两个或多个对象的差异、优缺点或适用场景。",
    examples: "“iPhone 和安卓手机有什么区别”“对比这两个方案”",
  },
  {
    id: "recommendation",
    name: "推荐",
    description: "用户希望根据条件得到商品、内容、目的地或方案推荐。",
    examples: "“推荐一款适合学生的电脑”“有什么电影值得看”",
  },
  {
    id: "planning",
    name: "规划",
    description: "用户希望制定步骤、计划、路线、日程或实施方案。",
    examples: "“帮我制定考研复习计划”“规划三天旅行路线”",
  },
  {
    id: "query-status",
    name: "状态查询",
    description: "用户希望读取当前设备、系统或环境的真实状态，通常需要 Agent Tool。",
    examples: "“现在电量是多少”“当前音量是多少”“蓝牙开着吗”",
  },
  {
    id: "control",
    name: "控制操作",
    description: "用户希望修改当前设备、系统或环境状态，通常需要 Agent Tool。",
    examples: "“声音小一点”“打开蓝牙”“暂停播放”",
  },
  {
    id: "emotional-support",
    name: "情绪支持",
    description: "用户主要希望获得安慰、陪伴、倾听或情绪回应。",
    examples: "“我今天特别难过”“可以安慰我一下吗”",
  },
  {
    id: "other",
    name: "其他意图",
    description: "用户目标明确，但确实无法归入以上意图。不能把无法理解的 Query 直接归到这里。",
    examples: "特殊业务请求",
  },
] as const

export type IntentId = (typeof INTENT_CATALOG)[number]["id"]
