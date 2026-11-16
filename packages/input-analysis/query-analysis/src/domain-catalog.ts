export const PRIMARY_DOMAIN_CATALOG = [
  {
    name: "通用知识",
    description:
      "普通百科、事实查询、人文社会和自然常识。适合“某人是谁”“某节日是哪天”“世界最高峰是什么”等 Query。",
  },
  {
    name: "教育",
    description:
      "明确处于课程学习、作业、考试、教学或升学场景。适合“讲解这道数学题”“高考物理考什么”等 Query。",
  },
  {
    name: "生活",
    description: "烹饪、家务、亲属关系、宠物、消费、人际交往等日常生活事务。",
  },
  {
    name: "医疗健康",
    description: "人体健康、疾病、症状、药品、心理健康、生育及医学检查等内容。",
  },
  {
    name: "科学技术",
    description:
      "自然科学原理、软件、人工智能、工程技术和工业知识。非课程场景的专业科学技术问题归这里。",
  },
  {
    name: "财经",
    description: "个人理财、投资、银行、保险、会计、税务和经济分析。",
  },
  {
    name: "商业",
    description: "企业信息、产品、市场、运营、管理、销售和创业。",
  },
  {
    name: "法律",
    description: "法律法规、合同、纠纷、权利义务、司法程序和合规。",
  },
  {
    name: "文化娱乐",
    description: "游戏、影视、动漫、音乐、文学、艺术和竞技体育。",
  },
  {
    name: "旅行",
    description: "目的地、行程、交通、住宿、签证和旅行安全。",
  },
  {
    name: "政治与公共事务",
    description: "国家制度、公共政策、政府治理、国际关系和外交。",
  },
  {
    name: "军事",
    description: "军事历史、武器装备、军队组织、军事理论和国防安全。",
  },
  {
    name: "设备与系统",
    description:
      "与玩偶本体、已连接设备或运行系统的能力说明、真实状态、控制操作、连接配置和故障排查有关的 Query。只有当用户在询问或操作具体设备或系统时才归入本领域；通用的计算机、软件和网络知识仍归入科学技术。",
  },
  {
    name: "记忆需求",
    description:
      "用户明确要求 Agent 保存、查询、更正或删除长期记忆。普通叙述中出现个人信息但没有明确记忆动作时，不自动归入本领域。",
  },
  {
    name: "其他",
    description: "Query 内容明确，但确实无法归入以上领域。不能把识别不清或模型不确定简单归为其他。",
  },
] as const

export type PrimaryDomain = (typeof PRIMARY_DOMAIN_CATALOG)[number]["name"]

export const PRIMARY_DOMAIN_NAMES = PRIMARY_DOMAIN_CATALOG.map(
  (domain) => domain.name,
) as PrimaryDomain[]
