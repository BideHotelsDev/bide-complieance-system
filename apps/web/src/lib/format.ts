/* en-GB dates and times in Europe/London (§10.1): "26 Oct 2026", "Mon 2 Nov", "14:05" */
const TZ = "Europe/London"

export function toDate(d: string | Date): Date {
  if (d instanceof Date) return d
  // Plain dates ("2026-11-09") are calendar days, not instants.
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? new Date(`${d}T12:00:00Z`) : new Date(d)
}

export function fmtDate(d: string | Date | null | undefined, withYear?: boolean): string {
  if (!d) return ""
  const date = toDate(d)
  const y = withYear ?? date.getUTCFullYear() !== new Date().getFullYear()
  return date.toLocaleDateString("en-GB", { day: "numeric", month: "short", ...(y ? { year: "numeric" } : {}), timeZone: TZ })
}

export function fmtDay(d: string | Date | null | undefined): string {
  if (!d) return ""
  return toDate(d).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: TZ })
}

export function fmtLongDay(d: string | Date): string {
  return toDate(d).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: TZ })
}

export function fmtTime(d: string | Date | null | undefined): string {
  if (!d) return ""
  return toDate(d).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: TZ })
}

export function fmtDateTime(d: string | Date | null | undefined): string {
  if (!d) return ""
  return `${fmtDate(d)}, ${fmtTime(d)}`
}

export function relative(d: string | Date): string {
  const ms = toDate(d).getTime() - Date.now()
  const days = Math.round(ms / 86400000)
  if (days === 0) return "today"
  if (days === 1) return "tomorrow"
  if (days === -1) return "yesterday"
  return days > 0 ? `in ${days} days` : `${-days} days ago`
}

export function greeting(): string {
  const h = Number(new Date().toLocaleString("en-GB", { hour: "numeric", hour12: false, timeZone: TZ }))
  return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening"
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`
}
