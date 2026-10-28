/*
 * Expiry timeline in the Certificates design's own layout: month columns, the 60-day window shaded, and marks
 * close together at the same property grouped under one label ("19–20 Aug  EL · PAT · View"), staggered on two
 * rows so labels don't collide. A local version of the kit's ExpiryTimeline, whose labels overlapped here.
 */
import * as React from "react"

import { cn } from "@bide-comply/ui/lib/utils"

type Mark = { id: string; date: string; title: string; property: string | null; status: string }

const DAY = 86400000
const LABEL_MAX = 200
const t = (d: string) => new Date(`${d.slice(0, 10)}T12:00:00Z`).getTime()
const dm = (ms: number, month = true) =>
  new Date(ms).toLocaleDateString("en-GB", {
    day: "numeric",
    ...(month ? { month: "short" } : {}),
    timeZone: "Europe/London",
  })
const shortProp = (p: string | null) => (p ? p.replace(/^The /, "") : null)

export function CertificateTimeline({
  start,
  end,
  months,
  marks,
  windowDays,
  label,
}: {
  start: string
  end: string
  months: { date: string; label: string }[]
  marks: Mark[]
  windowDays: number
  label: string
}) {
  const ref = React.useRef<HTMLDivElement>(null)
  const [width, setWidth] = React.useState(1000)
  React.useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(() => setWidth(el.clientWidth || 1000))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const s = t(start)
  const e = t(end)
  const pos = (ms: number) => Math.min(100, Math.max(0, ((ms - s) / (e - s)) * 100))

  const groups = (() => {
    const out: {
      key: string
      from: number
      to: number
      titles: string[]
      property: string | null
      status: string
      full: string[]
    }[] = []
    for (const m of [...marks].sort((a, b) => t(a.date) - t(b.date))) {
      const ms = t(m.date)
      const last = out[out.length - 1]
      if (last && last.property === m.property && ms - last.to <= 7 * DAY) {
        last.to = ms
        last.titles.push(m.title)
        last.full.push(`${m.title}: ${dm(ms)}`)
        if (m.status === "fails" || m.status === "expired") last.status = m.status
      } else
        out.push({
          key: m.id,
          from: ms,
          to: ms,
          titles: [m.title],
          property: m.property,
          status: m.status,
          full: [`${m.title}: ${dm(ms)}`],
        })
    }
    // Two staggered rows; more only if labels would still collide. Label widths are estimated from their text.
    const rightOnRow: number[] = []
    return out.map((g, i) => {
      const p = pos(g.from)
      const text = `${g.from === g.to ? "16 Dec" : "19–20 Aug"} ${g.titles.join(" · ")} · ${g.property ?? ""}`
      const w = (Math.min(text.length * 6.3, LABEL_MAX) / width) * 100
      const left = Math.min(Math.max(p - w / 2, 0), 100 - w)
      const order = [i % 2, (i + 1) % 2, 2, 3, 4, 5]
      const row = order.find((r) => rightOnRow[r] === undefined || rightOnRow[r] + 1 < left) ?? 5
      rightOnRow[row] = left + w
      return { ...g, p, row, left }
    })
  })()

  const rows = Math.max(2, ...groups.map((g) => g.row + 1))
  const height = 48 + rows * 40 + 22
  const win = pos(s + windowDays * DAY)

  return (
    <div className="overflow-x-auto">
      <div ref={ref} role="img" aria-label={label} className="relative mt-1.5 min-w-[720px]" style={{ height }}>
        {months.map((m, i) => {
          const a = pos(t(m.date))
          const b = i + 1 < months.length ? pos(t(months[i + 1].date)) : 100
          return (
            <React.Fragment key={m.date}>
              <span className="absolute top-0 bottom-[22px] border-l border-divider" style={{ left: `${a}%` }} />
              <span
                className="absolute bottom-0 -translate-x-1/2 text-xs text-muted-foreground"
                style={{ left: `${(a + b) / 2}%` }}
              >
                {m.label}
              </span>
            </React.Fragment>
          )
        })}
        <span className="absolute top-0 bottom-[22px] left-0 bg-st-amber-bg opacity-60" style={{ width: `${win}%` }} />
        <span
          className="absolute top-1 -translate-x-1/2 text-xs font-semibold whitespace-nowrap text-st-amber"
          style={{ left: `${win / 2}%` }}
        >
          {windowDays}-day window
        </span>
        {groups.map((g) => {
          const top = 48 + g.row * 40
          const tone =
            g.status === "fails" || g.status === "expired"
              ? "text-st-red"
              : g.status === "expiring" || g.status === "due"
                ? "text-st-amber"
                : "text-ink2"
          const when =
            g.from === g.to
              ? dm(g.from)
              : new Date(g.from).getUTCMonth() === new Date(g.to).getUTCMonth()
                ? `${dm(g.from, false)}–${dm(g.to)}`
                : `${dm(g.from)}–${dm(g.to)}`
          const text = `${g.titles.join(" · ")}${g.property ? ` · ${shortProp(g.property)}` : ""}`
          return (
            <React.Fragment key={g.key}>
              <span
                className={cn(
                  "absolute size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-[3px] border-surface bg-current shadow-[0_0_0_1px_currentColor]",
                  tone,
                )}
                style={{ left: `${g.p}%`, top }}
                title={g.full.join("\n")}
              />
              <span
                className={"absolute max-w-[200px] truncate text-xs whitespace-nowrap"}
                style={{ left: `${g.left}%`, top: top + 12 }}
                title={`${g.full.join("\n")}${g.property ? `\n${g.property}` : ""}`}
              >
                <strong className="font-semibold">{when}</strong> {text}
              </span>
            </React.Fragment>
          )
        })}
      </div>
    </div>
  )
}
