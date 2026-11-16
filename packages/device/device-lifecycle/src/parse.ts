import type { AgeGrade, DevicePresets } from "toy-device"
import type { SessionJson } from "toy-session"

/** session 预处理节点名：设备预设落在 `payload.preprocessing["device-presets"]`。 */
export const DEVICE_PRESETS_NODE = "device-presets"

/** 把 DevicePresets 转成可落库的纯 JSON 快照。 */
export function devicePresetsToSnapshot(presets: DevicePresets): SessionJson {
  const ageGrade = presets.ageGrade
  return {
    deviceId: presets.deviceId,
    agePreset: presets.agePreset,
    ageGrade:
      ageGrade === null
        ? null
        : {
            id: ageGrade.id,
            label: ageGrade.label,
            minAge: ageGrade.minAge,
            maxAge: ageGrade.maxAge,
            description: ageGrade.description,
          },
    personaPreset: presets.personaPreset,
  }
}

/** 从 session payload 里安全解析设备预设；缺失或非法时返回 null。 */
export function parseDevicePresets(payload: unknown): DevicePresets | null {
  const value = readPreprocessingValue(payload, DEVICE_PRESETS_NODE)
  return isDevicePresets(value) ? value : null
}

function readPreprocessingValue(payload: unknown, name: string): unknown {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return undefined
  }
  const preprocessing = (payload as Record<string, unknown>).preprocessing
  if (typeof preprocessing !== "object" || preprocessing === null || Array.isArray(preprocessing)) {
    return undefined
  }
  return (preprocessing as Record<string, unknown>)[name]
}

function isDevicePresets(value: unknown): value is DevicePresets {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false
  }
  const record = value as Record<string, unknown>
  return (
    typeof record.deviceId === "string" &&
    (typeof record.agePreset === "number" || record.agePreset === null) &&
    (record.ageGrade === null || isAgeGrade(record.ageGrade)) &&
    (typeof record.personaPreset === "string" || record.personaPreset === null)
  )
}

function isAgeGrade(value: unknown): value is AgeGrade {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false
  }
  const record = value as Record<string, unknown>
  return (
    typeof record.id === "string" &&
    typeof record.label === "string" &&
    typeof record.minAge === "number" &&
    (typeof record.maxAge === "number" || record.maxAge === null) &&
    typeof record.description === "string"
  )
}
