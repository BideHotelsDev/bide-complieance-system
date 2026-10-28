/*
 * Charts in the design's own style (design: Group overview): monochrome with status colours only, axes from zero,
 * units on axes, exact values on hover, legends only for more than one series, and every chart has a "View as
 * table" toggle and an aria-label summary (PRD §10.6).
 */
import * as React from "react"

import { cn } from "../lib/utils"

function useTableToggle() {
  const [table, setTable] = React.useState(false)
  const toggle = (
    <button type="button" onClick={() => setTable((t) => !t)} className="text-xs text-link hover:underline">
      {table ? "View as chart" : "View as table"}
    </button>
  )
  return { table, toggle }
}

function SimpleTable({ headers, rows }: { headers: string[]; rows: (string | number | null)[][] }) {
  return (
    <table className="w-full text-[13px]">
      <thead>
        <tr>
          {headers.map((h, i) => (
            <th key={h} className={cn("border-b border-divider py-1.5 font-medium text-muted-foreground", i ? "text-right" : "text-left")}>
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i}>
            {r.map((c, j) => (
              <td key={j} className={cn("border-b border-divider py-1.5", j ? "tabular text-right" : "")}>
                {c ?? "—"}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  )
}

export function ChartCard({
  title,
  badge,
  action,
  children,
  className,
}: {
  title: React.ReactNode
  badge?: React.ReactNode
  action?: React.ReactNode
  children: React.ReactNode
  className?: string
}) {
  return (
    <section className={cn("rounded-[10px] border border-divider bg-surface p-4", className)}>
      <div className="mb-3 flex items-center gap-2">
        <h2 className="m-0 text-[14px] font-semibold">{title}</h2>
        {badge}
        <div className="ml-auto flex items-center gap-3 text-[13px]">{action}</div>
      </div>
      {children}
    </section>
  )
}

/* Donut for a small part-to-whole (≤ 4 slices), monochrome greys from dark to light */
export function Donut({
  parts,
  total,
  centerLabel,
  label,
}: {
  parts: { label: string; sub?: string; value: number }[]
  total?: number
  centerLabel: string
  label: string
}) {
  const shades = ["var(--c-ink2)", "var(--c-subtle)", "#D5D5DB", "var(--c-divider)"]
  const sum = total ?? parts.reduce((a, p) => a + p.value, 0)
  const r = 52
  const c = 2 * Math.PI * r
  // Cumulative start of each slice, worked out before rendering.
  const starts = parts.map((_, i) => parts.slice(0, i).reduce((a, p) => a + (sum ? (p.value / sum) * c : 0), 0))
  return (
    <div className="flex items-center gap-5">
      <svg width="140" height="140" viewBox="0 0 140 140" role="img" aria-label={label} className="shrink-0">
        <circle cx="70" cy="70" r={r} fill="none" stroke="var(--c-divider)" strokeWidth="16" />
        {parts.map((p, i) => {
          const len = sum ? (p.value / sum) * c : 0
          return (
            <circle
              key={p.label}
              cx="70"
              cy="70"
              r={r}
              fill="none"
              stroke={shades[i]}
              strokeWidth="16"
              strokeDasharray={`${Math.max(len - 2.5, 0)} ${c}`}
              strokeDashoffset={-starts[i]}
              transform="rotate(-90 70 70)"
            >
              <title>{`${p.label}: ${p.value}`}</title>
            </circle>
          )
        })}
        <text x="70" y="70" textAnchor="middle" fontSize="26" fontWeight="600" fill="var(--c-foreground)">
          {sum}
        </text>
        <text x="70" y="88" textAnchor="middle" fontSize="11.5" fill="var(--c-muted)">
          {centerLabel}
        </text>
      </svg>
      <ul className="m-0 flex flex-1 list-none flex-col gap-2.5 p-0">
        {parts.map((p, i) => (
          <li key={p.label} className="flex items-center gap-2.5">
            <span aria-hidden className="size-2.5 shrink-0 rounded-[3px]" style={{ background: shades[i] }} />
            <span className="flex-1">
              {p.label}
              {p.sub && <span className="block text-xs text-muted-foreground">{p.sub}</span>}
            </span>
            <strong className="tabular font-semibold">{p.value}</strong>
          </li>
        ))}
      </ul>
    </div>
  )
}

/* Line, weekly, with the goal as a dashed green line (completion trend, DSH-04) */
export function LineTrend({
  points,
  goal,
  unit = "%",
  label,
  min,
  max = 100,
  valueName = "on time",
}: {
  points: { label: string; value: number | null; title?: string }[]
  goal?: number
  unit?: string
  label: string
  min?: number
  max?: number
  valueName?: string
}) {
  const { table, toggle } = useTableToggle()
  const W = 356
  const H = 164
  const L = 50
  const R = 348
  const T = 16
  const B = 140
  const vals = points.map((p) => p.value).filter((v): v is number => v != null)
  const lo = min ?? Math.max(0, Math.floor((Math.min(...(vals.length ? vals : [70]), goal ?? 100) - 10) / 10) * 10)
  const y = (v: number) => B - ((v - lo) / (max - lo)) * (B - T)
  const x = (i: number) => (points.length > 1 ? L + (i * (R - 2 - L)) / (points.length - 1) : (L + R) / 2)
  const ticks = [0, 1, 2, 3].map((i) => lo + ((max - lo) * i) / 3).map((v) => Math.round(v))
  const drawn = points.map((p, i) => (p.value == null ? null : `${x(i).toFixed(1)},${y(p.value).toFixed(1)}`))
  const segs = drawn.filter(Boolean).join(" ")
  return (
    <div>
      <div className="mb-1 flex justify-end">{toggle}</div>
      {table ? (
        <SimpleTable headers={["Week", `% ${valueName}`]} rows={points.map((p) => [p.title ?? p.label, p.value])} />
      ) : vals.length === 0 ? (
        <div className="flex h-[164px] items-center justify-center text-[13px] text-muted-foreground">
          Not enough checks yet to draw a trend.
        </div>
      ) : (
        <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label={label}>
          {ticks.map((t) => (
            <g key={t}>
              <line x1={L} x2={R} y1={y(t)} y2={y(t)} stroke="var(--c-divider)" />
              <text x={L - 8} y={y(t) + 4} textAnchor="end" fontSize="12" fill="var(--c-muted)">
                {t}
                {unit}
              </text>
            </g>
          ))}
          {goal != null && (
            <g>
              <line x1={L} x2={R} y1={y(goal)} y2={y(goal)} stroke="var(--c-green)" strokeDasharray="4 4" strokeWidth="1.5" />
              <text x={L + 4} y={y(goal) - 6} fontSize="12" fill="var(--c-green)">
                Goal {goal}
                {unit}
              </text>
            </g>
          )}
          <polyline points={segs} fill="none" stroke="var(--c-ink2)" strokeWidth="2" strokeLinejoin="round" />
          {points.map((p, i) =>
            p.value == null ? null : (
              <circle
                key={i}
                cx={x(i)}
                cy={y(p.value)}
                r={i === points.length - 1 ? 5 : 3.5}
                fill="var(--c-foreground)"
                stroke="var(--c-surface)"
                strokeWidth="2"
              >
                <title>{`${p.title ?? p.label}: ${p.value}${unit} ${valueName}`}</title>
              </circle>
            ),
          )}
          {points.map((p, i) => (
            <text key={`l${i}`} x={x(i)} y={158} textAnchor="middle" fontSize="12" fill="var(--c-muted)">
              {p.label}
            </text>
          ))}
        </svg>
      )}
    </div>
  )
}

/* Grouped bars for two series per period, e.g. Actions opened vs closed */
export function PairBars({
  points,
  series,
  label,
}: {
  points: { label: string; a: number; b: number; title?: string }[]
  series: [string, string]
  label: string
}) {
  const { table, toggle } = useTableToggle()
  const W = 356
  const H = 164
  const L = 30
  const R = 348
  const T = 12
  const B = 140
  const top = Math.max(4, ...points.flatMap((p) => [p.a, p.b]))
  const step = Math.ceil(top / 4)
  const max = step * 4
  const y = (v: number) => B - (v / max) * (B - T)
  const band = (R - L) / Math.max(points.length, 1)
  const bw = Math.min(12, band / 3)
  return (
    <div>
      <div className="mb-1 flex items-center justify-end gap-3 text-xs text-muted-foreground">
        <span className="flex items-center gap-1">
          <span aria-hidden className="size-2.5 rounded-[3px] bg-ink2" />
          {series[0]}
        </span>
        <span className="flex items-center gap-1">
          <span aria-hidden className="size-2.5 rounded-[3px] bg-border" />
          {series[1]}
        </span>
        {toggle}
      </div>
      {table ? (
        <SimpleTable headers={["Week", series[0], series[1]]} rows={points.map((p) => [p.title ?? p.label, p.a, p.b])} />
      ) : (
        <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label={label}>
          {[0, 1, 2, 3, 4].map((i) => (
            <g key={i}>
              <line x1={L} x2={R} y1={y(i * step)} y2={y(i * step)} stroke="var(--c-divider)" />
              <text x={L - 6} y={y(i * step) + 4} textAnchor="end" fontSize="12" fill="var(--c-muted)">
                {i * step}
              </text>
            </g>
          ))}
          {points.map((p, i) => {
            const cx = L + band * i + band / 2
            return (
              <g key={i}>
                <rect x={cx - bw - 1} y={y(p.a)} width={bw} height={B - y(p.a)} rx="2" fill="var(--c-ink2)">
                  <title>{`${p.title ?? p.label}: ${p.a} ${series[0].toLowerCase()}`}</title>
                </rect>
                <rect x={cx + 1} y={y(p.b)} width={bw} height={B - y(p.b)} rx="2" fill="var(--c-border)">
                  <title>{`${p.title ?? p.label}: ${p.b} ${series[1].toLowerCase()}`}</title>
                </rect>
                <text x={cx} y={158} textAnchor="middle" fontSize="12" fill="var(--c-muted)">
                  {p.label}
                </text>
              </g>
            )
          })}
        </svg>
      )}
    </div>
  )
}

/* Horizontal bars sorted worst first ("Which property is behind?") */
export function HBars({
  rows,
  label,
  unit = "",
  valueName = "",
}: {
  rows: { label: string; value: number; tone?: "red" | "amber" | "grey" | "ink"; note?: string }[]
  label: string
  unit?: string
  valueName?: string
}) {
  const { table, toggle } = useTableToggle()
  const max = Math.max(1, ...rows.map((r) => r.value))
  const color = { red: "var(--c-red)", amber: "var(--c-amber)", grey: "var(--c-border)", ink: "var(--c-ink2)" }
  return (
    <div>
      <div className="mb-1 flex justify-end">{toggle}</div>
      {table ? (
        <SimpleTable headers={["", valueName || "Value"]} rows={rows.map((r) => [r.label, r.value])} />
      ) : (
        <ul role="img" aria-label={label} className="m-0 flex list-none flex-col gap-3 p-0">
          {rows.map((r) => (
            <li key={r.label} className="grid grid-cols-[96px_1fr_40px] items-center gap-3 text-[13px]">
              <span className="truncate">{r.label}</span>
              <span className="h-2.5 overflow-hidden rounded-full bg-hover" title={`${r.label}: ${r.value}${unit}`}>
                <span
                  className="block h-full rounded-full"
                  style={{ width: `${(r.value / max) * 100}%`, background: color[r.tone ?? "ink"] }}
                />
              </span>
              <strong className="tabular text-right font-semibold">{r.value}</strong>
            </li>
          ))}
          {rows.some((r) => r.note) && <li className="text-xs text-muted-foreground">{rows.find((r) => r.note)?.note}</li>}
        </ul>
      )}
    </div>
  )
}

/* Property × domain heatmap (DSH-02): worst status per cell; word in the cell, not colour alone */
export function Heatmap({
  domains,
  rows,
  onCell,
}: {
  domains: { key: string; name: string }[]
  rows: { property_id: string; property: string; cells: { domain: string; status: string | null; counts: Record<string, number> }[] }[]
  onCell?: (propertyId: string, domain: string) => void
}) {
  const bg: Record<string, string> = {
    red: "bg-st-red-bg text-st-red",
    amber: "bg-st-amber-bg text-st-amber",
    green: "bg-st-green-bg text-st-green",
    grey: "bg-st-grey-bg text-st-grey",
  }
  const word: Record<string, string> = { red: "Red", amber: "Amber", green: "Green", grey: "N/A" }
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-separate border-spacing-1 text-[12px]">
        <thead>
          <tr>
            <th className="text-left font-medium text-muted-foreground" />
            {domains.map((d) => (
              <th key={d.key} scope="col" className="px-1 text-left font-medium whitespace-nowrap text-muted-foreground">
                {d.name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.property_id}>
              <th scope="row" className="pr-2 text-left font-medium whitespace-nowrap">
                {r.property}
              </th>
              {r.cells.map((c) => (
                <td key={c.domain} className="p-0">
                  {c.status ? (
                    <button
                      type="button"
                      onClick={onCell ? () => onCell(r.property_id, c.domain) : undefined}
                      title={Object.entries(c.counts)
                        .filter(([, n]) => n)
                        .map(([k, n]) => `${n} ${word[k].toLowerCase()}`)
                        .join(", ")}
                      className={cn("h-8 w-full min-w-[64px] rounded-md px-1.5 text-left font-medium", bg[c.status])}
                    >
                      {word[c.status]}
                      {c.status !== "grey" && c.counts[c.status] ? ` ${c.counts[c.status]}` : ""}
                    </button>
                  ) : (
                    <span className="block h-8 min-w-[64px] rounded-md border border-dashed border-divider" />
                  )}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/* Expiry timeline for the next 12 months with the 60-day window shaded (DSH-05) */
export function ExpiryTimeline({
  start,
  end,
  months,
  marks,
  windowDays = 60,
  label,
}: {
  start: string
  end: string
  months: { date: string; label: string }[]
  marks: { id: string; date: string; title: string; property?: string | null; status: string }[]
  windowDays?: number
  label: string
}) {
  const s = new Date(start).getTime()
  const e = new Date(end).getTime()
  const pos = (d: string) => ((new Date(d).getTime() - s) / (e - s)) * 100
  const win = ((windowDays * 86400000) / (e - s)) * 100
  // Spread labels over a few rows so close dates don't overlap.
  const rows: number[] = []
  const placed = marks.map((m) => {
    const p = pos(m.date)
    let row = 0
    while (rows[row] !== undefined && p - rows[row] < 14) row++
    rows[row] = p
    return { ...m, p, row }
  })
  return (
    <div role="img" aria-label={label} className="relative pt-2">
      <div className="relative h-[18px]">
        {months.map((m) => (
          <span
            key={m.date}
            className="absolute -translate-x-1/2 text-xs text-muted-foreground"
            style={{ left: `${pos(m.date)}%` }}
          >
            {m.label}
          </span>
        ))}
      </div>
      <div className="relative mt-1 h-2 rounded-full bg-hover">
        <div className="absolute inset-y-0 left-0 rounded-l-full bg-st-amber-bg" style={{ width: `${win}%` }} />
        <span className="absolute -top-5 left-0 text-[11px] text-st-amber">{windowDays}-day window</span>
        {placed.map((m) => (
          <span
            key={m.id}
            className={cn(
              "absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-surface",
              m.status === "expiring" || m.status === "due" ? "bg-st-amber" : m.status === "expired" ? "bg-st-red" : "bg-ink2",
            )}
            style={{ left: `${m.p}%` }}
            title={`${m.title}${m.property ? ` · ${m.property}` : ""}: ${new Date(m.date).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}`}
          />
        ))}
      </div>
      <div className="relative mt-2" style={{ height: `${(Math.max(...placed.map((p) => p.row), 0) + 1) * 34}px` }}>
        {placed.map((m) => (
          <span
            key={m.id}
            className="absolute max-w-[160px] -translate-x-1/2 text-center text-xs leading-tight"
            style={{ left: `${Math.min(Math.max(m.p, 6), 94)}%`, top: m.row * 34 }}
          >
            <strong className="block font-semibold">
              {new Date(m.date).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}
            </strong>
            <span className="text-muted-foreground">
              {m.title}
              {m.property ? ` · ${m.property}` : ""}
            </span>
          </span>
        ))}
      </div>
    </div>
  )
}

/* Small inline bar for three scorecard numbers, amber below target and red below 80 */
export function MeterBar({ value, target, label }: { value: number | null; target: number; label: string }) {
  if (value == null) return <span className="text-muted-foreground">—</span>
  const tone = value >= target ? "var(--c-green)" : value >= 80 ? "var(--c-amber)" : "var(--c-red)"
  return (
    <span className="flex items-center gap-2" title={`${label}: ${value}% (goal ${target}%)`}>
      <span className="tabular w-10 text-right font-semibold">{value}%</span>
      <span className="relative h-1.5 w-20 overflow-hidden rounded-full bg-hover">
        <span className="absolute inset-y-0 left-0 rounded-full" style={{ width: `${Math.min(value, 100)}%`, background: tone }} />
        <span className="absolute inset-y-0 w-px bg-foreground/40" style={{ left: `${target}%` }} />
      </span>
    </span>
  )
}

/* A stacked bar for a status mix (e.g. 22 late · 3 soon · 9 OK · 4 not started) */
export function MixBar({
  parts,
  label,
}: {
  parts: { label: string; value: number; tone: "red" | "amber" | "green" | "grey" | "border" }[]
  label: string
}) {
  const total = parts.reduce((a, p) => a + p.value, 0) || 1
  const color = {
    red: "var(--c-red)",
    amber: "var(--c-amber)",
    green: "var(--c-green)",
    grey: "var(--c-subtle)",
    border: "var(--c-border)",
  }
  return (
    <span aria-label={label} role="img" className="flex h-1.5 w-full overflow-hidden rounded-full bg-hover">
      {parts.map((p) =>
        p.value ? (
          <span key={p.label} title={`${p.value} ${p.label}`} style={{ width: `${(p.value / total) * 100}%`, background: color[p.tone] }} />
        ) : null,
      )}
    </span>
  )
}
