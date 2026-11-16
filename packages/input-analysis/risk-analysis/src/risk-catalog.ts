export const RISK_CATEGORY_CATALOG = [
  {
    id: "none",
    name: "无风险",
    description: "没有识别到相关风险类别。",
    examples: "普通、不涉及风险的 Query",
  },
  {
    id: "sexual",
    name: "色情与性内容",
    description:
      "包含露骨色情描写、性行为、色情内容生成或其他成人性内容。正常医学、健康和性教育内容也可能命中该类别，但风险通常较低。",
    examples: "“生成露骨色情内容”“青春期性教育应该讲什么”",
  },
  {
    id: "violence",
    name: "暴力与血腥",
    description: "包含伤害、杀戮、虐待、血腥场景或暴力实施内容。历史、新闻和影视讨论也可能命中。",
    examples: "“分析战争电影中的暴力镜头”“怎样伤害某人”",
  },
  {
    id: "self-harm",
    name: "自伤与自杀",
    description: "包含自残、自杀念头、计划、方法或求助信号。",
    examples: "“我不想活了”“自杀有哪些方法”",
  },
  {
    id: "hate",
    name: "仇恨与歧视",
    description: "针对种族、民族、宗教、性别等群体的贬低、歧视、去人化或仇恨表达。",
    examples: "“写一段攻击某族群的内容”",
  },
  {
    id: "harassment",
    name: "侮辱与骚扰",
    description: "针对个人的羞辱、威胁、恶意攻击或持续骚扰。",
    examples: "“帮我写一段羞辱同事的话”",
  },
  {
    id: "illegal",
    name: "违法犯罪",
    description: "请求实施、协助、规避侦查或优化违法犯罪行为。",
    examples: "“怎么伪造证明”“怎样绕过执法检查”",
  },
  {
    id: "weapons",
    name: "武器与危险装置",
    description:
      "涉及武器、爆炸物及其他危险装置的制造、获取或使用。普通军事百科也可能命中，但风险较低。",
    examples: "“枪械的工作原理”“怎么制造爆炸装置”",
  },
  {
    id: "drugs",
    name: "毒品与受控物质",
    description: "涉及毒品、受控药物的制造、交易、滥用或规避检测。",
    examples: "“怎样提纯毒品”“吸食后有什么表现”",
  },
  {
    id: "minor-safety",
    name: "未成年人安全",
    description: "涉及未成年人色情、诱骗、虐待、危险行为或其他未成年人伤害。",
    examples: "“生成涉及未成年人的色情内容”",
  },
  {
    id: "privacy",
    name: "隐私与个人数据",
    description: "请求获取、公开、推断或滥用他人的私密信息和个人数据。",
    examples: "“帮我查这个人的家庭住址”“公开他的手机号”",
  },
  {
    id: "fraud",
    name: "欺诈与冒充",
    description: "涉及诈骗、钓鱼、身份冒充、虚假材料或欺骗性获利。",
    examples: "“帮我写银行钓鱼短信”",
  },
  {
    id: "cyber-abuse",
    name: "网络攻击与滥用",
    description: "涉及未授权入侵、恶意软件、凭证盗取或破坏计算机系统。",
    examples: "“写一个窃取密码的程序”",
  },
  {
    id: "extremism",
    name: "极端主义",
    description: "涉及极端组织宣传、招募、美化、支持或实施相关暴力活动。",
    examples: "“为极端组织写招募文案”",
  },
] as const

export const RISK_CONTEXT_CATALOG = [
  {
    id: "benign",
    name: "普通提及",
    description: "只是提到相关概念，没有露骨描述或实施意图。",
    examples: "“暴力是什么意思”",
  },
  {
    id: "educational",
    name: "教育研究",
    description: "用于课程、科普、研究、预防或安全教育。",
    examples: "“学校应该如何开展反暴力教育”",
  },
  {
    id: "news",
    name: "新闻事实",
    description: "讨论新闻、历史事件或公共事实。",
    examples: "“分析这起暴力事件的社会背景”",
  },
  {
    id: "fictional",
    name: "虚构作品",
    description: "讨论小说、影视、游戏或其他虚构场景。",
    examples: "“分析电影中的战争场面”",
  },
  {
    id: "graphic",
    name: "露骨描写",
    description: "重点要求血腥、色情或其他露骨细节。",
    examples: "“详细描写血腥伤口”",
  },
  {
    id: "instructional",
    name: "方法指导",
    description: "要求可执行的步骤、方法、材料或操作建议。",
    examples: "“告诉我具体怎么伤害他”",
  },
] as const

export const RISK_LEVEL_CATALOG = [
  {
    id: "none",
    name: "无风险",
    description: "没有识别到相关风险类别。categories 应为空数组。",
  },
  {
    id: "low",
    name: "低风险",
    description: "普通提及、教育、历史、新闻或虚构讨论，没有露骨细节和实施意图。",
  },
  {
    id: "medium",
    name: "中风险",
    description:
      "内容具有明显敏感性，包含一定细节、强烈情绪或潜在不当用途，但没有明确的严重伤害实施请求。",
  },
  {
    id: "high",
    name: "高风险",
    description: "请求露骨内容、危险指导、违法协助、隐私侵害或具有较强可执行性。",
  },
  {
    id: "critical",
    name: "严重风险",
    description: "存在迫近的自伤、伤人、未成年人性伤害或其他可能导致严重现实伤害的信号。",
  },
] as const

export type RiskCategoryId = (typeof RISK_CATEGORY_CATALOG)[number]["id"]
export type RiskContextId = (typeof RISK_CONTEXT_CATALOG)[number]["id"]
export type RiskLevelId = (typeof RISK_LEVEL_CATALOG)[number]["id"]
