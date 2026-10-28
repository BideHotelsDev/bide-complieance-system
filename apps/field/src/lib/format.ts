/* Dates en-GB, in UK time. */

const LONDON = "Europe/London"

export function fmtDate(d: string | Date | null | undefined): string {
  if (!d) return ""
  return new Date(d).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: LONDON })
}

export function fmtDay(d: string | Date): string {
  return new Date(d).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: LONDON })
}

export function fmtTime(d: string | Date): string {
  return new Date(d).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: LONDON })
}

/* "26 Oct 2026 09:41 BST": the time line on the camera stamp. */
export function fmtStamp(d: Date): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: LONDON,
    timeZoneName: "short",
  }).formatToParts(d)
  const p = (t: string) => parts.find((x) => x.type === t)?.value ?? ""
  const raw = p("timeZoneName")
  const zone = raw === "GMT+1" ? "BST" : raw === "GMT+0" || raw === "UTC" ? "GMT" : raw
  return `${p("day")} ${p("month")} ${p("year")} ${p("hour")}:${p("minute")} ${zone}`
}

/* "P. Mathers" */
export function shortName(name: string): string {
  const bits = name.trim().split(/\s+/)
  if (bits.length < 2) return name
  return `${bits[0][0]}. ${bits.slice(1).join(" ")}`
}

/* "a, b and c" */
export function listWords(items: string[]): string {
  if (items.length <= 1) return items.join("")
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`
}

export function fmtSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
