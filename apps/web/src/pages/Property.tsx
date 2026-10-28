/*
 * One property (design: One property): header, summary strip, and tabs for the register, Actions, opening checklist,
 * certificates, alarm events and people. The register opens items in a side sheet (?item=<ref>).
 */
import { useQuery } from "@tanstack/react-query"
import { Link, useParams as useRouteParams } from "@tanstack/react-router"
import * as React from "react"

import { api, ApiError } from "@bide-comply/api-client"
import { Button } from "@bide-comply/ui/components/button"
import { MixBar } from "@bide-comply/ui/components/charts"
import { Breadcrumb, ErrorState, LoadingPage, NoPermission } from "@bide-comply/ui/components/page"
import { Pill } from "@bide-comply/ui/components/status"
import { cn } from "@bide-comply/ui/lib/utils"

import { RaiseActionDialog } from "@/features/overview/property-dialogs"
import { RegisterTab } from "@/features/overview/property-register"
import { ActionsTab, AlarmTab, CertificatesTab, OpeningTab, PeopleTab } from "@/features/overview/property-tabs"
import type { PropertyDetail } from "@/features/overview/property-types"
import { toDate } from "@/lib/format"
import { useParams } from "@/lib/params"
import { useMe } from "@/lib/session"

const monthYear = (d: string) =>
  toDate(d).toLocaleDateString("en-GB", { month: "short", year: "numeric", timeZone: "Europe/London" })

function subtitle(p: PropertyDetail) {
  const stage =
    p.stage === "trading"
      ? p.trading_since
        ? `trading since ${monthYear(p.trading_since)}`
        : "trading"
      : p.stage === "pre_opening"
        ? p.opening_date
          ? `opens ${monthYear(p.opening_date)}`
          : "opening soon"
        : (p.stage_note ?? "not set up yet")
  return [p.town, stage, p.dutyholder ? `dutyholder: ${p.dutyholder}` : null].filter(Boolean).join(" · ")
}

/* A thin stacked bar in ink shades (Actions by urgency, checklist done) */
function InkBar({ parts, label }: { parts: { value: number; cls: string; title: string }[]; label: string }) {
  const total = parts.reduce((a, p) => a + p.value, 0)
  return (
    <span role="img" aria-label={label} className="flex h-1.5 w-full overflow-hidden rounded-full bg-hover">
      {total > 0 &&
        parts.map((p) =>
          p.value ? <span key={p.title} title={p.title} className={p.cls} style={{ flex: p.value }} /> : null,
        )}
    </span>
  )
}

function SummaryCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2 rounded-[10px] border border-divider bg-surface p-4">
      <span className="text-[12.5px] text-muted-foreground">{title}</span>
      {children}
    </div>
  )
}

function Big({ value, unit }: { value: React.ReactNode; unit?: React.ReactNode }) {
  return (
    <span className="tabular text-[24px] leading-none font-semibold tracking-[-0.02em]">
      {value}
      {unit && <span className="ml-1 text-[13px] font-normal tracking-normal text-muted-foreground">{unit}</span>}
    </span>
  )
}

type Tab = "register" | "actions" | "opening" | "certificates" | "alarms" | "people"

export function PropertyPage() {
  const { code } = useRouteParams({ strict: false }) as { code?: string }
  const [p, set] = useParams()
  const me = useMe()
  const [raise, setRaise] = React.useState(false)
  const q = useQuery<PropertyDetail, ApiError>({
    queryKey: ["property", code, "detail"],
    queryFn: () => api.get<PropertyDetail>(`/api/properties/${code}`),
    enabled: !!code,
  })
  if (q.isPending) return <LoadingPage />
  if (q.error) {
    if (q.error.status === 403) return <NoPermission message="This property isn't one of yours." />
    if (q.error.status === 404)
      return <ErrorState title="Property not found" message={`There is no property with the code ${code}.`} />
    return <ErrorState message={q.error.message} onRetry={() => void q.refetch()} />
  }
  const d = q.data
  const can = me.data?.can ?? {}
  const tabs: { key: Tab; label: string; count?: number }[] = [
    { key: "register", label: "Register" },
    { key: "actions", label: "Actions", count: d.actions.open },
    { key: "opening", label: "Opening checklist" },
    { key: "certificates", label: "Certificates" },
    { key: "alarms", label: "Alarm events" },
    ...(can["people.view"] ? [{ key: "people" as const, label: "People" }] : []),
  ]
  const tab = (tabs.find((t) => t.key === p.tab)?.key ?? "register") as Tab
  const c = d.checks
  const g = d.gate
  const statusBadge =
    d.score_status === "red" ? (
      <Pill tone="red" dot>
        {d.red_line ? "Red · red-line" : "Red"}
      </Pill>
    ) : (
      <Pill tone={d.score_status} dot>
        {d.status_label}
      </Pill>
    )

  return (
    <div className="flex flex-col gap-4">
      <Breadcrumb items={[{ label: "Properties", href: "/properties" }, { label: d.name }]} />
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2.5">
            <h1 className="m-0 text-[20px] leading-tight font-semibold">{d.name}</h1>
            <span className="mono-id text-muted-foreground">{d.code}</span>
            {statusBadge}
            {d.legal_hold && <Pill tone="blue">Legal hold</Pill>}
          </div>
          <p className="m-0 mt-1 text-muted-foreground">{subtitle(d)}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {can["export.pack"] && (
            <Button variant="outline" asChild>
              <Link to="/reports" search={{ property: d.id }}>
                Inspection pack
              </Link>
            </Button>
          )}
          {can["action.raise"] && <Button onClick={() => setRaise(true)}>Raise an Action</Button>}
        </div>
      </header>

      <section aria-label="Summary" className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <SummaryCard title="Score">
          <Big value={d.score == null ? "—" : `${d.score}%`} />
          {d.score_status === "red" && d.class_a_late > 0 ? (
            <Pill tone="red" className="self-start">
              Red · {d.class_a_late} life-safety late
            </Pill>
          ) : (
            <Pill tone={d.score_status} className="self-start">
              {d.register_loaded ? d.status_label : "No register yet"}
            </Pill>
          )}
        </SummaryCard>
        <SummaryCard title="Checks">
          <Big value={c.late} unit={`late of ${c.total}`} />
          <MixBar
            label={`${c.total} checks: ${c.late} late, ${c.soon} due soon, ${c.ok} OK, ${c.na} not applicable`}
            parts={[
              { label: "late", value: c.late, tone: "red" },
              { label: "soon", value: c.soon, tone: "amber" },
              { label: "OK", value: c.ok, tone: "green" },
              { label: "not applicable", value: c.na, tone: "border" },
            ]}
          />
          <span className="text-xs text-muted-foreground">
            {c.late} late · {c.soon} soon · {c.ok} OK · {c.na} n/a
          </span>
        </SummaryCard>
        <SummaryCard title="Actions open">
          <Big value={d.actions.open} unit={`· ${d.actions.late} running late`} />
          <InkBar
            label={`${d.actions.urgent} urgent, ${d.actions.soon} soon, ${d.actions.later} later`}
            parts={[
              { value: d.actions.urgent, cls: "bg-ink2", title: `${d.actions.urgent} urgent` },
              { value: d.actions.soon, cls: "bg-subtle", title: `${d.actions.soon} soon` },
              { value: d.actions.later, cls: "bg-border", title: `${d.actions.later} later` },
            ]}
          />
          <span className="text-xs text-muted-foreground">
            {d.actions.urgent} urgent · {d.actions.soon} soon{d.actions.later ? ` · ${d.actions.later} later` : ""}
          </span>
        </SummaryCard>
        <SummaryCard title="Opening checklist">
          {g && g.applicable > 0 ? (
            <>
              <Big value={g.done} unit={`of ${g.applicable} done`} />
              <InkBar
                label={`${g.done} of ${g.applicable} done`}
                parts={[
                  { value: g.done, cls: "bg-ink2", title: `${g.done} done` },
                  { value: g.applicable - g.done, cls: "bg-hover", title: `${g.applicable - g.done} to do` },
                ]}
              />
              <span className={cn("text-xs", g.class_a_open ? "text-st-red" : "text-muted-foreground")}>
                {g.class_a_open} life-safety item{g.class_a_open === 1 ? "" : "s"} open
              </span>
            </>
          ) : (
            <>
              <Big value="—" />
              <span className="text-xs text-muted-foreground">No checklist yet</span>
            </>
          )}
        </SummaryCard>
      </section>

      <div role="tablist" aria-label="Property sections" className="flex gap-5 overflow-x-auto border-b border-divider">
        {tabs.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={tab === t.key}
            onClick={() => set({ tab: t.key === "register" ? undefined : t.key, item: undefined })}
            className={cn(
              "-mb-px inline-flex shrink-0 items-center gap-1.5 border-b-2 py-2 text-[13px] whitespace-nowrap",
              tab === t.key
                ? "border-foreground font-medium text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {t.label}
            {t.count != null && t.count > 0 && (
              <Pill tone="grey" className="h-[18px] px-1.5 text-[11.5px]">
                {t.count}
              </Pill>
            )}
          </button>
        ))}
      </div>

      <div role="tabpanel" aria-label={tabs.find((t) => t.key === tab)?.label}>
        {tab === "register" && <RegisterTab property={d} />}
        {tab === "actions" && <ActionsTab property={d} />}
        {tab === "opening" && <OpeningTab property={d} />}
        {tab === "certificates" && <CertificatesTab property={d} />}
        {tab === "alarms" && <AlarmTab property={d} />}
        {tab === "people" && <PeopleTab property={d} />}
      </div>

      <RaiseActionDialog open={raise} onOpenChange={setRaise} propertyId={d.id} propertyName={d.name} />
    </div>
  )
}
