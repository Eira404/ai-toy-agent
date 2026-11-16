/**
 * 触发时间计算辅助。
 *
 * 触发钟点 `daily_at` 只存 "HH:mm" 一个墙钟时间，不含时区；接口额外传入 IANA 时区
 * `timeZone`（省略时用服务器本地时区），据此把「用户时间 + 时区」换算成下一次触发的
 * 绝对时间 `next_run_at` 写入数据库。这样无论用户和服务器是否同区，触发都发生在用户
 * 所选时区的 HH:mm。
 */

/** 24 小时制 "HH:mm"（要求补零）。 */
const DAILY_AT_RE = /^([01]\d|2[0-3]):([0-5]\d)$/

/** 解析 "HH:mm"，非法返回 null。 */
export function parseDailyAt(value: string): { readonly hours: number; readonly minutes: number } | null {
  const match = DAILY_AT_RE.exec(value.trim())
  if (match === null) {
    return null
  }
  return { hours: Number(match[1]), minutes: Number(match[2]) }
}

/** 服务器本地 IANA 时区名（省略 timeZone 时的默认值）。 */
export function serverTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone
}

/** 判断是否合法的 IANA 时区（非法时 Intl 构造会抛 RangeError）。 */
export function isValidTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value })
    return true
  } catch {
    return false
  }
}

/**
 * 计算 `now` 之后最近一个 `dailyAt` 时刻（在 `timeZone` 时区下），返回 ISO 字符串。
 *
 * 若该时区下今天的该钟点还没到，返回今天；否则返回明天。因此结果恒严格大于 `now`，
 * 调度器据此推进 `next_run_at`，天然实现「当天放弃 / 触发后顺延到下一天」。
 *
 * 已知限制：跨夏令时边界的重合/跳变时刻按近似偏移处理，可能偏移一小时；
 * 对无夏令时的地区（如 Asia/Shanghai）无影响。
 */
export function nextDailyOccurrence(now: Date, dailyAt: string, timeZone: string): string {
  const parsed = parseDailyAt(dailyAt)
  if (parsed === null) {
    throw new Error(`dailyAt '${dailyAt}' 必须是 HH:mm（24 小时制）`)
  }
  const today = wallClockOf(now, timeZone)
  // 最多向后找 3 天，覆盖跨月与夏令时边界。
  for (let offset = 0; offset < 3; offset++) {
    const candidateMs = wallClockToUtcMs(
      today.year,
      today.month,
      today.day + offset,
      parsed.hours,
      parsed.minutes,
      timeZone,
    )
    if (candidateMs > now.getTime()) {
      return new Date(candidateMs).toISOString()
    }
  }
  throw new Error(`无法计算 '${dailyAt}' 在时区 '${timeZone}' 的下一次触发时间`)
}

/** 读取某个绝对时刻在 `timeZone` 下的墙钟年/月/日。 */
function wallClockOf(date: Date, timeZone: string): { readonly year: number; readonly month: number; readonly day: number } {
  const parts = tzParts(date, timeZone)
  return { year: parts.year, month: parts.month, day: parts.day }
}

/** 把 `timeZone` 下的墙钟 `year/month/day hour:minute` 换算成 UTC 毫秒。 */
function wallClockToUtcMs(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): number {
  // 先把墙钟当作 UTC 得到一个参考毫秒，再用该时区在参考时刻的偏移校正。
  const asUtc = Date.UTC(year, month - 1, day, hour, minute, 0, 0)
  return asUtc - tzOffsetMinutes(asUtc, timeZone) * 60_000
}

/** 计算 `utcMs` 时刻 `timeZone` 相对 UTC 的偏移分钟数（东八区为 +480）。 */
function tzOffsetMinutes(utcMs: number, timeZone: string): number {
  const parts = tzParts(new Date(utcMs), timeZone)
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second)
  return Math.round((asUtc - utcMs) / 60_000)
}

/** 用 Intl 读取某个时刻在 `timeZone` 下的墙钟字段。 */
function tzParts(date: Date, timeZone: string): {
  readonly year: number
  readonly month: number
  readonly day: number
  readonly hour: number
  readonly minute: number
  readonly second: number
} {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  })
  const map = new Map<string, string>()
  for (const part of formatter.formatToParts(date)) {
    map.set(part.type, part.value)
  }
  return {
    year: Number(map.get("year")),
    month: Number(map.get("month")),
    day: Number(map.get("day")),
    hour: Number(map.get("hour")),
    minute: Number(map.get("minute")),
    second: Number(map.get("second")),
  }
}
