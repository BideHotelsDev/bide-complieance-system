/*
 * Home: the group overview (design: Group overview, PRD DSH-01..05). What's red, what needs you, and the trends.
 * Below 768px it becomes the phone layout (design: Manager on phone).
 */
import { useQuery } from "@tanstack/react-query"
import { useRouter } from "@tanstack/react-router"
import { AlertTriangle, Check, Download, Flag, Phone, PenLine } from "lucide-react"
import * as React from "react"

import { api, ApiError, download } from "@bide-comply/api-client"
import { Button } from "@bide-comply/ui/components/button"
import { Donut, HBars, Heatmap, LineTrend, PairBars } from "@bide-comply/ui/components/charts"
import { Segmented } from "@bide-comply/ui/components/filter-bar"
import { EmptyState, ErrorState, LoadingPage, NoPermission } from "@bide-comply/ui/components/page"
import { Pill, RagBadge } from "@bide-comply/ui/components/status"
import { toastError } from "@bide-comply/ui/components/toaster"
import { cn } from "@bide-comply/ui/lib/utils"

import { exportRows, GROUP_COLUMNS, GroupTable } from "@/features/overview/home-group-table"
import { MobileHomeView } from "@/features/overview/home-mobile"
import {
  AppLink,
  hello,
  joinNames,
  opensLabel,
  useMediaQuery,
  type Overview,
  type PropertySummary,
  type TodoItem,
} from "@/features/overview/home-shared"
import { fmtDate, fmtLongDay, fmtTime } from "@/lib/format"
import { useParams } from "@/lib/params"
import { useProperty } from "@/lib/property"
import { navFor, useMe } from "@/lib/session"
import { MyTodoPage } from "./MyTodo"

type Period = "week" | "month" | "quarter"

export function HomePage() {
  const me = useMe()
  const phone = useMediaQuery("(max-width: 767px)")
  const today = new Date().toISOString().slice(0, 10)
  if (phone) return <MobileHomeView today={today} />
  // People without the group dashboard (site leads, staff) land on their own to-do.
  if (me.data && !me.data.can["dashboard.view"]) return <MyTodoPage />
  return <DesktopHome />
}

function Panel({
  title,
  link,
  badge,
  className,
  children,
}: {
  title: string
  link?: React.ReactNode
  badge?: React.ReactNode
  className?: string
  children: React.ReactNode
}) {
  return (
    <section
      className={cn(
        "flex min-w-0 flex-col gap-3.5 rounded-xl border border-divider bg-surface px-[18px] py-4",
        className,
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <h2 className="m-0 text-[15px] font-semibold">{title}</h2>
        {badge}
        {link && <div className="flex items-center gap-3 text-[13px] font-medium">{link}</div>}
      </div>
      {children}
    </section>
  )
}

const LK = "text-[13px] font-medium text-link no-underline hover:underline"

function DesktopHome() {
  const me = useMe()
  const { propertyId, property } = useProperty()
  const [params, set] = useParams()
  const period = (["week", "month", "quarter"].includes(params.period ?? "") ? params.period : "week") as Period
  const q = useQuery<Overview, ApiError>({
    queryKey: ["overview", propertyId, period],
    queryFn: () => api.get<Overview>("/api/overview", { property: propertyId, period }),
    placeholderData: (prev) => prev,
  })
  const [exporting, setExporting] = React.useState(false)

  if (q.isError && q.error.status === 403) return <NoPermission />
  const o = q.data
  const mine = me.data?.properties ?? []
  const scope = property ? property.name : mine.length === 1 ? mine[0].name : "all properties"

  const doExport = async () => {
    if (!o) return
    setExporting(true)
    try {
      await download(
        "/api/export",
        { name: "Group overview", columns: GROUP_COLUMNS, rows: exportRows(o), format: "csv" },
        "Group overview.csv",
      )
    } catch (e) {
      toastError(e instanceof ApiError ? e.message : "The export didn't finish. Try again.", () => void doExport())
    } finally {
      setExporting(false)
    }
  }

  return (
    <div className="flex max-w-[1240px] flex-col gap-[18px]">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="m-0 text-[24px] font-semibold tracking-[-0.02em]">
            {hello(me.data?.name, me.data?.first_name)}
          </h1>
          <p className="m-0 mt-0.5 text-muted-foreground">
            {fmtLongDay(o?.today ?? new Date())} · {scope}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Segmented<Period>
            label="Period"
            value={period}
            onChange={(v) => set({ period: v === "week" ? undefined : v })}
            options={[
              { value: "week", label: "Week" },
              { value: "month", label: "Month" },
              { value: "quarter", label: "Quarter" },
            ]}
          />
          <Button variant="secondary" onClick={() => void doExport()} disabled={!o || exporting}>
            <Download aria-hidden />
            {exporting ? "Exporting…" : "Export"}
          </Button>
        </div>
      </header>

      {q.isPending ? (
        <LoadingPage />
      ) : q.isError || !o ? (
        <ErrorState message={q.error?.message} onRetry={() => void q.refetch()} />
      ) : (
        <OverviewBody o={o} />
      )}
    </div>
  )
}

function OverviewBody({ o }: { o: Overview }) {
  const router = useRouter()
  const me = useMe()
  const [asTable, setAsTable] = React.useState(false)
  const k = o.kpis
  const shown = o.properties.filter((p) => p.stage !== "setup")
  const notSetUp = o.properties.filter((p) => p.stage === "setup")
  const setupNote = notSetUp.find((p) => p.stage_note)?.stage_note
  const onTimeChange = k.on_time.value != null && k.on_time.prev != null ? k.on_time.value - k.on_time.prev : null
  const trendVals = o.on_time_trend.map((p) => p.on_time).filter((v): v is number => v != null)
  const codeById = new Map(o.properties.map((p) => [p.id, p.code]))
  const heatRows = o.heatmap.rows.filter((r) => r.cells.some((c) => c.status))

  return (
    <>
      {o.banner && (
        <div
          role="alert"
          className="flex items-center gap-3 rounded-[10px] border border-st-red/25 bg-st-red-bg px-3.5 py-2.5 text-[14px] text-st-red"
        >
          <AlertTriangle aria-hidden className="size-[18px] shrink-0" />
          <span className="flex-1">
            <strong className="font-semibold">{o.banner.text}</strong>
            {o.banner.extra && ` ${o.banner.extra}`}
          </span>
          <AppLink
            href={o.banner.link}
            className="inline-flex h-[30px] items-center rounded-md border border-st-red/30 px-3 text-[13px] font-medium whitespace-nowrap text-st-red no-underline hover:bg-st-red/5"
          >
            See what to do
          </AppLink>
        </div>
      )}

      <section aria-label="Key numbers" className="grid grid-cols-2 gap-3.5 lg:grid-cols-4">
        <KpiCard label="Life-safety items open" value={k.life_safety_open.value}>
          <span className="text-[12.5px] text-muted-foreground">
            across {k.life_safety_open.properties} {k.life_safety_open.properties === 1 ? "property" : "properties"}
          </span>
          <Pill tone={k.life_safety_open.value > k.life_safety_open.goal ? "red" : "green"} className="self-start">
            Goal: {k.life_safety_open.goal}
          </Pill>
        </KpiCard>
        <KpiCard label="Urgent actions running late" value={k.urgent_late.value}>
          <Dots on={k.urgent_late.value} of={k.urgent_late.of} />
          <span className="text-xs text-muted-foreground">of {k.urgent_late.of} urgent actions</span>
        </KpiCard>
        <KpiCard
          label="Checks done on time"
          title={k.on_time.definition}
          value={k.on_time.value == null ? "—" : `${k.on_time.value}%`}
          aside={<Spark values={trendVals} />}
        >
          {onTimeChange == null ? (
            <span className="text-xs text-muted-foreground">Goal {k.on_time.goal}%</span>
          ) : (
            <span
              className={cn(
                "text-xs font-medium",
                onTimeChange > 0 ? "text-st-green" : onTimeChange < 0 ? "text-st-red" : "text-muted-foreground",
              )}
            >
              {onTimeChange > 0 ? "▲" : onTimeChange < 0 ? "▼" : "–"} {Math.abs(onTimeChange)}{" "}
              {Math.abs(onTimeChange) === 1 ? "point" : "points"} on last week
            </span>
          )}
        </KpiCard>
        <KpiCard label="Waiting for your decision" value={k.decisions.value}>
          <span aria-hidden className="flex h-2 gap-0.5 overflow-hidden rounded">
            {k.decisions.advisories > 0 && <span className="bg-ink2" style={{ flex: k.decisions.advisories }} />}
            {k.decisions.signoffs > 0 && <span className="bg-subtle" style={{ flex: k.decisions.signoffs }} />}
            {k.decisions.value === 0 && <span className="flex-1 bg-hover" />}
          </span>
          <span className="text-xs text-muted-foreground">
            <span className="text-ink2">■</span> {k.decisions.advisories}{" "}
            {k.decisions.advisories === 1 ? "advisory" : "advisories"} · <span className="text-subtle">■</span>{" "}
            {k.decisions.signoffs} {k.decisions.signoffs === 1 ? "sign-off" : "sign-offs"}
          </span>
        </KpiCard>
      </section>

      <div className="grid gap-3.5 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <Panel
          title="Life-safety checks late, by property"
          link={
            <>
              <button
                type="button"
                onClick={() => setAsTable((t) => !t)}
                className="text-xs font-normal text-link hover:underline"
              >
                {asTable ? "View as cards" : "View as table"}
              </button>
              {me.data && navFor(me.data).properties && (
                <AppLink href="/properties" className={LK}>
                  All properties
                </AppLink>
              )}
            </>
          }
        >
          {asTable ? (
            <GroupTable overview={o} />
          ) : shown.length === 0 ? (
            <EmptyState title="No properties to show">None of your properties have a register yet.</EmptyState>
          ) : (
            <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4">
              {shown.map((p) => (
                <PropertyTile key={p.id} p={p} />
              ))}
            </div>
          )}
          {notSetUp.length > 0 && (
            <span className="text-[12.5px] text-muted-foreground">
              Not set up yet: {joinNames(notSetUp.map((p) => p.name))}
              {setupNote ? ` (${setupNote.replace(/^Loads/, "loading")})` : ""}
            </span>
          )}
        </Panel>
        <Panel
          title="Needs you"
          link={
            <AppLink href="/todo" className={LK}>
              My to-do
            </AppLink>
          }
        >
          {o.needs_you.length === 0 ? (
            <EmptyState title="Nothing needs you" className="py-6">
              You're up to date. New decisions and alerts appear here.
            </EmptyState>
          ) : (
            <div className="flex flex-col">
              {o.needs_you.map((n) => (
                <NeedRow key={n.id} n={n} today={o.today} />
              ))}
            </div>
          )}
        </Panel>
      </div>

      <div className="grid gap-3.5 lg:grid-cols-3">
        <Panel
          title="Open actions by urgency"
          link={
            <AppLink href="/actions" className={LK}>
              Open
            </AppLink>
          }
        >
          <Donut
            label={`Open actions: ${o.actions_by_urgency.high} urgent, ${o.actions_by_urgency.med} soon, ${o.actions_by_urgency.low} later`}
            centerLabel="open"
            parts={[
              { label: "Urgent", sub: "Fix within 7 days", value: o.actions_by_urgency.high },
              { label: "Soon", sub: "Fix within 30 days", value: o.actions_by_urgency.med },
              { label: "Later", sub: "Fix within 90 days", value: o.actions_by_urgency.low },
            ]}
          />
        </Panel>
        <Panel title="Checks done on time">
          <LineTrend
            label={`Checks done on time each week, goal ${k.on_time.goal}%`}
            goal={k.on_time.goal}
            points={o.on_time_trend.map((p) => ({
              label: p.label,
              value: p.on_time,
              title:
                p.on_time == null
                  ? `${p.label}: no checks due`
                  : `${p.label}: ${p.on_time}% of ${p.due} checks on time`,
            }))}
          />
        </Panel>
        <Panel title="Actions opened vs closed">
          <PairBars
            label="Actions opened and closed each week"
            series={["Opened", "Closed"]}
            points={o.actions_trend.map((p) => ({
              label: p.label,
              a: p.opened,
              b: p.closed,
              title: `${p.label}: ${p.opened} opened, ${p.closed} closed`,
            }))}
          />
        </Panel>
      </div>

      <div className="grid gap-3.5 lg:grid-cols-2">
        <Panel
          title="Life-safety items still open"
          link={
            <AppLink href="/gates" className={LK}>
              Opening checklists
            </AppLink>
          }
        >
          <HBars
            label="Life-safety (Class A) opening checklist items still open, by property"
            valueName="Class A items open"
            unit=" open"
            rows={o.gate_open.map((g) => ({
              label: g.property,
              value: g.class_a_open,
              tone: g.opened ? "ink" : "grey",
              note: o.gate_open.some((x) => !x.opened) ? "Grey: not open yet" : undefined,
            }))}
          />
        </Panel>
        <Panel
          title="Next certificates to renew"
          link={
            <AppLink href="/certificates" className={LK}>
              All certificates
            </AppLink>
          }
        >
          {o.next_certificates.length === 0 ? (
            <EmptyState title="No renewals coming up" className="py-6">
              No certificate expires in the next 12 months.
            </EmptyState>
          ) : (
            <div className="flex flex-col">
              {o.next_certificates.map((c) => (
                <AppLink
                  key={c.id}
                  href={`/certificates?sel=${c.id}`}
                  className="flex items-center gap-2.5 border-b border-divider py-[9px] text-foreground no-underline last:border-b-0 hover:bg-hover/40"
                >
                  <span className="flex w-11 shrink-0 flex-col items-center text-xs leading-[1.1] text-muted-foreground">
                    <strong className="tabular text-[18px] font-semibold text-foreground">
                      {new Date(`${c.expires_on}T12:00:00Z`).getUTCDate()}
                    </strong>
                    {new Date(`${c.expires_on}T12:00:00Z`).toLocaleDateString("en-GB", { month: "short" })}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{c.title}</span>
                    <span className="block text-xs text-muted-foreground">{c.property}</span>
                  </span>
                  <Pill tone={c.days < 0 ? "red" : c.days <= 60 ? "amber" : "grey"}>
                    {c.days < 0 ? `Expired ${-c.days} days ago` : `${c.days} days`}
                  </Pill>
                </AppLink>
              ))}
            </div>
          )}
        </Panel>
      </div>

      {heatRows.length > 0 && (
        <Panel title="Status by property and area">
          <p className="m-0 -mt-1.5 text-[12.5px] text-muted-foreground">
            The worst status in each area. Pick a cell to see those checks.
          </p>
          <Heatmap
            domains={o.heatmap.domains}
            rows={heatRows}
            onCell={(pid, domain) => {
              const code = codeById.get(pid)
              if (code) void router.navigate({ href: `/properties/${code}?area=${domain}` })
            }}
          />
        </Panel>
      )}

      <p className="m-0 text-xs text-muted-foreground">
        Hover or tap any chart for exact numbers · every chart has a table view · updated {fmtTime(o.updated_at)}
      </p>
    </>
  )
}

function KpiCard({
  label,
  value,
  aside,
  title,
  children,
}: {
  label: string
  value: React.ReactNode
  aside?: React.ReactNode
  title?: string
  children?: React.ReactNode
}) {
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-divider bg-surface p-4" title={title}>
      <span className="flex items-center gap-1.5 text-[13px] font-medium text-ink2">{label}</span>
      <span className="flex items-center gap-3">
        <span className="tabular text-[32px] leading-none font-semibold tracking-[-0.03em]">{value}</span>
        {aside}
      </span>
      {children}
    </div>
  )
}

function Dots({ on, of }: { on: number; of: number }) {
  const n = Math.min(of, 40)
  return (
    <span
      className="flex flex-wrap gap-[3px]"
      role="img"
      aria-label={`${on} of ${of} urgent actions are past 7 days`}
      title={`${on} of ${of} urgent actions are past 7 days`}
    >
      {Array.from({ length: n }).map((_, i) => (
        <span key={i} className={cn("size-[9px] rounded-full", i < on ? "bg-foreground" : "bg-border")} />
      ))}
    </span>
  )
}

function Spark({ values }: { values: number[] }) {
  if (values.length < 2) return null
  const W = 80
  const H = 28
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * W},${H - 2 - (v / 100) * (H - 4)}`).join(" ")
  return (
    <svg width={W} height={H} aria-hidden className="shrink-0">
      <polyline
        points={pts}
        fill="none"
        stroke="var(--c-ink2)"
        strokeWidth={1.75}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  )
}

function PropertyTile({ p }: { p: PropertySummary }) {
  const opening = p.stage === "pre_opening"
  const tile = "flex min-w-0 flex-col gap-1 rounded-[10px] border border-divider p-3 text-foreground no-underline"
  let big: string
  let caption: string
  if (p.register_loaded) {
    big = String(p.class_a_late)
    caption = `life-safety ${p.class_a_late === 1 ? "check" : "checks"} late`
  } else if (opening && p.gate) {
    big = `${p.gate.done}/${p.gate.applicable}`
    caption = "checklist done"
  } else {
    big = "–"
    caption = "register not loaded"
  }
  const body = (
    <>
      <span className="text-[13.5px] font-semibold">{p.name}</span>
      <span className="text-xs text-muted-foreground">{p.town ?? " "}</span>
      <span
        className={cn(
          "tabular mt-1.5 text-[30px] leading-[1.1] font-semibold tracking-[-0.02em]",
          !p.register_loaded && "text-subtle",
        )}
      >
        {big}
      </span>
      <span className="text-[12.5px] text-ink2">{caption}</span>
      {p.register_loaded && p.score != null && (
        <>
          <span className="mt-1.5 block h-1.5 rounded-[3px] bg-hover" title={`Score ${p.score}%`}>
            <span className="block h-1.5 rounded-[3px] bg-ink2" style={{ width: `${p.score}%` }} />
          </span>
          <span className="text-xs text-muted-foreground">Score {p.score}%</span>
        </>
      )}
      <span className="mt-1 self-start">
        {opening ? (
          <Pill tone="grey">{opensLabel(p.opening_date)}</Pill>
        ) : (
          <RagBadge status={p.score_status} label={p.status_label} />
        )}
      </span>
    </>
  )
  return (
    <AppLink
      href={opening ? `/gates/${p.code}` : `/properties/${p.code}`}
      className={cn(tile, "hover:bg-hover/60")}
      title={p.red_line ? "Red because a life-safety (Class A) item is overdue, whatever the score" : undefined}
    >
      {body}
    </AppLink>
  )
}

const ICON: Record<string, { el: React.ReactNode; cls: string }> = {
  call: { el: <Phone className="size-4" />, cls: "bg-st-red-bg text-st-red" },
  approval: { el: <Check className="size-4" />, cls: "bg-st-blue-bg text-st-blue" },
  action: { el: <Flag className="size-4" />, cls: "bg-st-amber-bg text-st-amber" },
  sign: { el: <PenLine className="size-4" />, cls: "bg-st-grey-bg text-ink2" },
}

function NeedRow({ n, today }: { n: TodoItem; today: string }) {
  const icon = ICON[n.kind] ?? ICON.action
  const late = n.due_on != null && n.due_on < today
  // "The Villa · Gallagher": the second line is the shortest useful context; full detail is on hover.
  return (
    <AppLink
      href={n.link}
      title={`${n.title}\n${n.detail}`}
      className="flex items-center gap-2.5 border-b border-divider py-[9px] text-foreground no-underline last:border-b-0 hover:bg-hover/40"
    >
      <span
        aria-hidden
        className={cn("inline-flex size-[30px] shrink-0 items-center justify-center rounded-lg", icon.cls)}
      >
        {icon.el}
      </span>
      <span className="min-w-0 flex-1">
        <span className="line-clamp-2 font-medium">{n.title}</span>
        <span className="block truncate text-xs text-muted-foreground">{n.detail}</span>
      </span>
      {n.kind === "call" ? (
        <Pill tone="red">Today</Pill>
      ) : late ? (
        <Pill tone="red">Late</Pill>
      ) : n.due_on ? (
        <Pill tone="amber">{fmtDate(n.due_on)}</Pill>
      ) : n.kind === "approval" ? (
        <Pill tone="blue">Decide</Pill>
      ) : null}
    </AppLink>
  )
}
