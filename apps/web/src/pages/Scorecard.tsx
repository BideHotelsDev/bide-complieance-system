/*
 * Team scorecard (design: Scorecard, SCO-01..05). Three numbers per person, only what the person controls; sites
 * compete in the monthly league, not individuals. Shared on the Friday all-team call.
 */
import { useQuery } from "@tanstack/react-query"
import { ShieldCheck } from "lucide-react"

import { api, ApiError } from "@bide-comply/api-client"
import { MeterBar } from "@bide-comply/ui/components/charts"
import { Avatar, Callout, Card, ErrorState, LoadingPage, NoPermission, PageHeader } from "@bide-comply/ui/components/page"
import { Pill } from "@bide-comply/ui/components/status"
import { Button } from "@bide-comply/ui/components/button"
import { toast, toastError } from "@bide-comply/ui/components/toaster"
import { cn } from "@bide-comply/ui/lib/utils"

import { copyText } from "@/features/insight/ui"
import { plural } from "@/lib/format"
import { useParams } from "@/lib/params"
import { useProperty } from "@/lib/property"
import { useMe } from "@/lib/session"

type Band = "green" | "amber" | "red" | "none"
type PersonRow = {
  id: string
  name: string
  initials: string
  property: string
  on_time: number | null
  on_time_band: Band
  evidence: number | null
  evidence_band: Band
  actions: number | null
  actions_band: Band
  checks: number
  actions_due: number
  streak: number
}
type Goal = { label: string; value: number | null; unit?: string; goal: string; on_goal: boolean }
type LeagueRow = {
  property: string
  score: number | null
  position: number | null
  clean_sheet?: boolean
  red_line?: boolean
  joins?: string
}
type Scorecard = {
  week_start: string
  week_label: string
  prev_week: string
  next_week: string | null
  targets: { on_time: number; evidence: number; actions: number }
  goals: Goal[]
  people: PersonRow[]
  league: LeagueRow[]
  month_label: string
  definitions: Record<string, string>
}

export function ScorecardPage() {
  const me = useMe().data
  if (!me?.can["scorecard.view"]) return <NoPermission message="The team scorecard is for managers and directors." />
  return <Scorecard />
}

function Scorecard() {
  const [params, set] = useParams()
  const { propertyId } = useProperty()
  const q = useQuery<Scorecard, ApiError>({
    queryKey: ["scorecard", params.week ?? null, propertyId],
    queryFn: () => api.get<Scorecard>("/api/scorecard", { week: params.week, property: propertyId }),
  })
  if (q.isPending) return <LoadingPage />
  if (q.error)
    return q.error.status === 403 ? <NoPermission /> : <ErrorState message={q.error.message} onRetry={() => void q.refetch()} />
  const d = q.data

  const share = async () => {
    const ok = await copyText(summary(d))
    if (ok) toast("Summary copied. Paste it into the Friday call notes or Slack.")
    else toastError("Couldn't copy the summary. Your browser blocked the clipboard.")
  }

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Team scorecard"
        subtitle={`${d.week_label} · shared on the Friday all-team call`}
        actions={
          <>
            <Button variant="outline" onClick={() => set({ week: d.prev_week })}>
              ‹ Previous week
            </Button>
            {d.next_week && (
              <Button variant="outline" onClick={() => set({ week: d.next_week ?? undefined })}>
                Next week ›
              </Button>
            )}
            <Button variant="outline" onClick={() => void share()}>
              Share to Friday call
            </Button>
          </>
        }
      />
      <Callout tone="green" icon={<ShieldCheck className="size-4" aria-hidden />}>
        <strong className="font-semibold">Finding a problem never costs points.</strong> Reporting it scores the same as a pass.
      </Callout>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_370px]">
        <League rows={d.league} month={d.month_label} />
        <Goals goals={d.goals} />
      </div>

      <People rows={d.people} targets={d.targets} definitions={d.definitions} />
    </div>
  )
}

function League({ rows, month }: { rows: LeagueRow[]; month: string }) {
  const scored = rows.filter((r) => r.score != null)
  const joining = rows.filter((r) => r.score == null)
  const goal = 95
  return (
    <Card
      title="Site league · score by month"
      action={<span className="text-muted-foreground">{month}</span>}
      bodyClassName="flex flex-col gap-4 p-4"
    >
      <ol className="m-0 flex list-none flex-wrap gap-2 p-0" aria-label="Site league positions">
        {scored.map((r) => (
          <li key={r.property} className="flex items-center gap-2 rounded-full border border-divider py-1 pr-2 pl-1">
            <span
              className={cn(
                "inline-flex size-6 items-center justify-center rounded-full text-[12px] font-semibold",
                r.position === 1 ? "bg-primary text-primary-foreground" : "bg-hover text-ink2",
              )}
              aria-label={`Position ${r.position}`}
            >
              {r.position}
            </span>
            <span className="font-semibold">{r.property}</span>
            <span className="tabular text-muted-foreground">{r.score}%</span>
            {r.clean_sheet && <Pill tone="green">Clean sheet</Pill>}
            {r.red_line && (
              <Pill tone="red" title="Shown red because a life-safety (Class A) item is overdue, whatever the percentage.">
                Life-safety item overdue
              </Pill>
            )}
          </li>
        ))}
        {joining.map((r) => (
          <li key={r.property} className="flex items-center gap-2 rounded-full border border-divider py-1 pr-3 pl-1">
            <span aria-hidden className="inline-flex size-6 items-center justify-center rounded-full bg-hover text-[12px] text-muted-foreground">
              –
            </span>
            <span className="font-semibold">{r.property}</span>
            <span className="text-muted-foreground">{(r.joins ?? "joins later").replace(/^Joins/, "joins")}</span>
          </li>
        ))}
      </ol>

      {scored.length === 0 ? (
        <p className="m-0 text-[13px] text-muted-foreground">
          No property has a score yet. Sites join the league once their register is loaded and checks are live.
        </p>
      ) : (
        <div>
          <ul role="img" aria-label={`Score this month: ${scored.map((r) => `${r.property} ${r.score}%`).join(", ")}. Goal ${goal}%.`} className="m-0 flex list-none flex-col gap-3 p-0">
            {scored.map((r) => {
              const score = r.score ?? 0
              const tone = r.red_line || score < 80 ? "var(--c-red)" : score < goal ? "var(--c-amber)" : "var(--c-green)"
              return (
                <li key={r.property} className="grid grid-cols-[120px_1fr_44px] items-center gap-3 text-[13px]">
                  <span className="truncate">{r.property}</span>
                  <span className="relative h-2.5 rounded-full bg-hover" title={`${r.property}: ${score}%`}>
                    <span className="absolute inset-y-0 left-0 rounded-full" style={{ width: `${Math.min(score, 100)}%`, background: tone }} />
                    <span aria-hidden className="absolute -inset-y-1 w-0 border-l border-dashed border-st-green" style={{ left: `${goal}%` }} />
                  </span>
                  <strong className="tabular text-right font-semibold">{score}%</strong>
                </li>
              )
            })}
          </ul>
          <p className="m-0 mt-3 text-xs text-muted-foreground">
            Dashed line: goal {goal}%. A site with an overdue life-safety (Class A) item shows red whatever its score. A clean
            sheet month has nothing overdue.
          </p>
        </div>
      )}
    </Card>
  )
}

function Goals({ goals }: { goals: Goal[] }) {
  return (
    <Card title="Weekly goals" action={<span className="text-muted-foreground">Live</span>} bodyClassName="flex flex-col gap-5 p-4">
      {goals.map((g) => {
        const pct = g.unit === "%"
        const value = g.value ?? 0
        const width = pct ? Math.min(value, 100) : g.on_goal ? 0 : Math.min(100, Math.max(6, value * 6))
        const goalPos = pct ? parseInt(g.goal, 10) || 0 : 0
        return (
          <div key={g.label}>
            <div className="flex items-center gap-2">
              <span className="flex-1 font-medium">{g.label}</span>
              <span className="tabular text-[20px] leading-none font-semibold">
                {g.value == null ? "—" : `${g.value}${g.unit ?? ""}`}
              </span>
              {g.on_goal ? <Pill tone="green">✓ On goal</Pill> : <Pill tone="red">! Off goal</Pill>}
            </div>
            <span className="relative mt-2.5 block h-2 rounded-full bg-hover" aria-hidden>
              <span
                className="absolute inset-y-0 left-0 rounded-full"
                style={{ width: `${width}%`, background: g.on_goal ? "var(--c-green)" : "var(--c-red)" }}
              />
              <span className="absolute -inset-y-1 w-0.5 bg-foreground" style={{ left: `${goalPos}%` }} />
            </span>
            <div className="mt-1.5 text-xs text-muted-foreground">Goal: {g.goal}</div>
          </div>
        )
      })}
    </Card>
  )
}

function People({
  rows,
  targets,
  definitions,
}: {
  rows: PersonRow[]
  targets: Scorecard["targets"]
  definitions: Record<string, string>
}) {
  const best = Math.max(0, ...rows.map((r) => r.streak))
  const th = "h-[34px] px-3 text-left text-xs font-medium whitespace-nowrap text-muted-foreground"
  return (
    <Card
      title="People · this week"
      action={<span className="text-muted-foreground">Three numbers each, only what the person controls</span>}
    >
      {rows.length === 0 ? (
        <p className="m-0 p-4 text-[13px] text-muted-foreground">Nobody has checks or actions at this property yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-[13.5px]">
            <thead className="bg-background">
              <tr className="border-b border-divider">
                <th scope="col" className={th}>Person</th>
                <th scope="col" className={th}>Property</th>
                <th scope="col" className={cn(th, "text-right")} title={definitions.on_time}>
                  Checks on time · {targets.on_time}%
                </th>
                <th scope="col" className={cn(th, "text-right")} title={definitions.evidence_complete}>
                  Evidence complete · {targets.evidence}%
                </th>
                <th scope="col" className={cn(th, "text-right")} title={definitions.actions_on_time}>
                  Actions on time · {targets.actions}%
                </th>
                <th scope="col" className={th}>Streak</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="h-12 border-b border-divider last:border-b-0">
                  <td className="px-3">
                    <span className="flex items-center gap-2.5">
                      <Avatar initials={r.initials} className="size-[26px] text-[11px]" />
                      <span className="whitespace-nowrap">{r.name}</span>
                    </span>
                  </td>
                  <td className="px-3 whitespace-nowrap">{r.property}</td>
                  <td className="px-3">
                    <Cell show={r.checks > 0} empty="No checks">
                      <MeterBar value={r.on_time} target={targets.on_time} label="Checks on time" />
                    </Cell>
                  </td>
                  <td className="px-3">
                    <Cell show={r.checks > 0} empty="—">
                      <MeterBar value={r.evidence} target={targets.evidence} label="Evidence complete" />
                    </Cell>
                  </td>
                  <td className="px-3">
                    <Cell show={r.actions_due > 0} empty="No actions">
                      <MeterBar value={r.actions} target={targets.actions} label="Actions on time" />
                    </Cell>
                  </td>
                  <td className="px-3 whitespace-nowrap">
                    {r.streak > 0 ? (
                      <Pill tone="green" title={`${plural(r.streak, "week")} in a row with every check on time`}>
                        {plural(r.streak, "week")}
                        {r.streak === best ? " at 100%" : ""}
                      </Pill>
                    ) : r.checks > 0 ? (
                      <span className="text-muted-foreground">Streak reset</span>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="m-0 border-t border-divider px-4 py-3 text-xs text-muted-foreground">
        Bars turn amber below target and red below 80%. The number is always shown, so colour is never the only signal.
      </p>
    </Card>
  )
}

function Cell({ show, empty, children }: { show: boolean; empty: string; children: React.ReactNode }) {
  return <span className="flex justify-end whitespace-nowrap">{show ? children : <span className="text-muted-foreground">{empty}</span>}</span>
}

/* Plain text for the Friday call: goals and the site league. Individual numbers stay on screen (SCO-03). */
function summary(d: Scorecard): string {
  const lines = [`Team scorecard · ${d.week_label}`, "Finding a problem never costs points. Reporting it scores the same as a pass.", "", "Weekly goals"]
  for (const g of d.goals)
    lines.push(`- ${g.label}: ${g.value == null ? "no data" : `${g.value}${g.unit ?? ""}`} (goal ${g.goal}) · ${g.on_goal ? "on goal" : "off goal"}`)
  lines.push("", `Site league · ${d.month_label}`)
  for (const r of d.league) {
    if (r.score == null) lines.push(`- ${r.property}: ${(r.joins ?? "joins later").toLowerCase()}`)
    else
      lines.push(
        `${r.position}. ${r.property} ${r.score}%${r.clean_sheet ? " · clean sheet" : ""}${r.red_line ? " · life-safety item overdue" : ""}`,
      )
  }
  const streaks = d.people.filter((p) => p.streak > 0).length
  if (streaks) lines.push("", `${plural(streaks, "person", "people")} on a streak of every check on time.`)
  return lines.join("\n")
}
