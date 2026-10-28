/* One property card on the Properties page (design: Properties). The link and the three numbers depend on the stage. */
import { Link } from "@tanstack/react-router"
import * as React from "react"

import { GateBadge, Pill, RagBadge, ScoreRing, type Rag } from "@bide-comply/ui/components/status"
import { cn } from "@bide-comply/ui/lib/utils"

export type PropertyRow = {
  id: string
  name: string
  code: string
  town: string | null
  dutyholder: string | null
  jurisdiction: string
  stage: "trading" | "pre_opening" | "setup" | string
  stage_label: string
  stage_note: string | null
  trading_since: string | null
  opening_date: string | null
  register_loaded: boolean
  score: number | null
  score_status: Rag
  status_label: string
  red_line: boolean
  class_a_late: number
  checks: { late: number; soon: number; ok: number; na: number; total: number }
  actions: { open: number; urgent: number; soon: number; later: number; late: number }
  gate: {
    status: "not_ready" | "ready_to_open" | "trading_a_open"
    applicable: number
    done: number
    percent: number
    class_a_open: number
  } | null
  due_14: number
  certs_60: number
  days_since_alarm_test: number | null
  note: string | null
}

const JURISDICTION: Record<string, string> = { england: "England", wales: "Wales", scotland: "" }

export function placeLine(p: PropertyRow): string {
  const town = p.town ? `${p.town}${JURISDICTION[p.jurisdiction] ? `, ${JURISDICTION[p.jurisdiction]}` : ""}` : null
  return [town, p.dutyholder ?? (p.stage === "setup" ? null : "dutyholder to confirm")].filter(Boolean).join(" · ")
}

export function openingLabel(d: string | null): { month: string; year: string } | null {
  if (!d) return null
  const date = new Date(`${d}T12:00:00Z`)
  return {
    month: date.toLocaleDateString("en-GB", { month: "short", timeZone: "Europe/London" }),
    year: String(date.getUTCFullYear()),
  }
}

export function StatusFor({ p }: { p: PropertyRow }) {
  if (p.stage === "setup") return <Pill tone="grey">Not set up</Pill>
  if (p.stage === "pre_opening" && p.gate) return <GateBadge status={p.gate.status} />
  return <RagBadge status={p.score_status} label={p.status_label} />
}

/** Where a card goes: trading properties to their page, opening soon to the opening checklist, not set up to setup. */
export function PropertyLink({
  p,
  className,
  children,
  ...rest
}: { p: PropertyRow; className?: string; children: React.ReactNode } & Omit<React.ComponentProps<"a">, "href">) {
  if (p.stage === "setup")
    return (
      <Link to="/settings/setup/$code" params={{ code: p.code }} className={className} {...rest}>
        {children}
      </Link>
    )
  if (p.stage === "pre_opening")
    return (
      <Link to="/gates/$code" params={{ code: p.code }} className={className} {...rest}>
        {children}
      </Link>
    )
  return (
    <Link to="/properties/$code" params={{ code: p.code }} className={className} {...rest}>
      {children}
    </Link>
  )
}

function Num({ value, label }: { value: React.ReactNode; label: string }) {
  return (
    <div className="flex flex-col rounded-lg bg-sidebar px-2.5 py-2">
      <b className="tabular text-[18px] font-semibold">{value}</b>
      <span className="text-xs text-muted-foreground">{label}</span>
    </div>
  )
}

export function PropertyCard({ p }: { p: PropertyRow }) {
  const setup = p.stage === "setup"
  const opening = p.stage === "pre_opening"
  const ringScore = p.score ?? (opening && p.gate ? p.gate.percent : null)
  const ringStatus: Rag = opening || setup ? "grey" : p.score == null ? "grey" : p.score_status
  const when = openingLabel(p.opening_date)
  return (
    <PropertyLink
      p={p}
      aria-label={`${p.name}, ${p.status_label}`}
      className={cn(
        "flex flex-col gap-3.5 rounded-xl border border-divider bg-surface p-[18px] text-foreground no-underline hover:shadow-[0_0_0_1px_var(--c-border)]",
        setup && "border-dashed",
      )}
    >
      <div className="flex items-center gap-3.5">
        <ScoreRing score={ringScore} status={ringStatus} redLine={p.red_line} />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="text-[17px] font-semibold">{p.name}</span>
            <span className="mono-id text-muted-foreground">{p.code}</span>
          </span>
          <span className="block text-[12.5px] text-muted-foreground">{placeLine(p)}</span>
        </span>
        <StatusFor p={p} />
      </div>
      {setup ? (
        <span className="text-muted-foreground">
          {p.stage_note ? `${p.stage_note}. ` : ""}
          <span className="font-medium text-link">Set up now</span>
        </span>
      ) : (
        <>
          <div className="grid grid-cols-3 gap-2">
            {opening ? (
              <>
                <Num value={p.gate ? `${p.gate.done}/${p.gate.applicable}` : "—"} label="Gate items done" />
                <Num value={p.actions.urgent} label="Urgent actions" />
                <Num value={when?.month ?? "—"} label={when ? `Opening ${when.year}` : "Opening date to set"} />
              </>
            ) : (
              <>
                {p.register_loaded ? (
                  <Num value={p.class_a_late} label="Life-safety overdue" />
                ) : (
                  <Num value="—" label="Register not loaded" />
                )}
                <Num value={p.actions.urgent} label="Urgent actions" />
                <Num value={p.gate ? p.gate.class_a_open : "—"} label="Gate A open" />
              </>
            )}
          </div>
          {p.note && <span className="text-[12.5px] text-muted-foreground">{p.note}</span>}
        </>
      )}
    </PropertyLink>
  )
}
