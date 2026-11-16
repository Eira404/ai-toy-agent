import type { AgeGrade } from "./age-grades.js"

/** 一个玩偶的预设快照：透传 debug 设备记录里的年龄与人设，并附加年龄分级。 */
export interface DevicePresets {
  readonly deviceId: string
  /** 年龄预设：透传 device.age（孩子岁数）；null 表示未设置。 */
  readonly agePreset: number | null
  /** 由年龄换算出的年龄分级；年龄未设置时为 null。 */
  readonly ageGrade: AgeGrade | null
  /** 人设预设：透传 device.persona（可注入 system prompt 的完整文本）；null 表示无人设。 */
  readonly personaPreset: string | null
}
