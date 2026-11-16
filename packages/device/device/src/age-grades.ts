/** 年龄分级的稳定标识。 */
export type AgeGradeId = "infant" | "preschool" | "early-school" | "late-school" | "teen" | "adult"

/** 一个年龄分级：覆盖 [minAge, maxAge]（含端点）；maxAge 为 null 表示无上限。 */
export interface AgeGrade {
  readonly id: AgeGradeId
  readonly label: string
  readonly minAge: number
  readonly maxAge: number | null
  /** 面向模型的年龄分级说明，可直接注入 system prompt。 */
  readonly description: string
}

/** 年龄分级目录，按年龄从低到高排列，覆盖所有非负整数岁。 */
export const AGE_GRADES: readonly AgeGrade[] = [
  {
    id: "infant",
    label: "婴幼儿",
    minAge: 0,
    maxAge: 3,
    description: "0–3 岁婴幼儿：语言启蒙期，用词简短、多重复，多用拟声与韵律，回答应温柔且简短。",
  },
  {
    id: "preschool",
    label: "学龄前",
    minAge: 4,
    maxAge: 6,
    description: "4–6 岁学龄前儿童：以具体形象思维为主，喜欢童话、绘本与游戏化的表达。",
  },
  {
    id: "early-school",
    label: "小学低年级",
    minAge: 7,
    maxAge: 9,
    description: "7–9 岁小学低年级：开始识字与独立阅读，适合简单科普与好奇问答。",
  },
  {
    id: "late-school",
    label: "小学高年级",
    minAge: 10,
    maxAge: 12,
    description: "10–12 岁小学高年级：逻辑与兴趣拓展期，可进行更完整、有条理的解释。",
  },
  {
    id: "teen",
    label: "青少年",
    minAge: 13,
    maxAge: 17,
    description: "13–17 岁青少年：抽象思维发展，适合更成熟、平等且尊重隐私的对话。",
  },
  {
    id: "adult",
    label: "成人",
    minAge: 18,
    maxAge: null,
    description: "18 岁及以上成人：常规成人对话。",
  },
]

/** 把年龄（岁）换算为年龄分级；age 为 null 时返回 null。 */
export function gradeAge(age: number | null): AgeGrade | null {
  if (age === null) {
    return null
  }
  return (
    AGE_GRADES.find(
      (grade) => age >= grade.minAge && (grade.maxAge === null || age <= grade.maxAge),
    ) ?? null
  )
}
