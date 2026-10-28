/*
 * Reports and packs (design: Reports, DSH-07..09). Make a pack for an inspector or insurer in two minutes: who and
 * what period, what to include, format; the cover page preview updates as you choose. Scheduled reports and past
 * exports sit in their own tabs.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Download, FileText, Loader2 } from "lucide-react"
import * as React from "react"

import { api, ApiError } from "@bide-comply/api-client"
import { Button } from "@bide-comply/ui/components/button"
import { Checkbox } from "@bide-comply/ui/components/checkbox"
import {
  Card,
  EmptyState,
  ErrorState,
  LoadingPage,
  LoadingRows,
  Mark,
  NoPermission,
  PageHeader,
} from "@bide-comply/ui/components/page"
import { Pill } from "@bide-comply/ui/components/status"
import { Switch } from "@bide-comply/ui/components/switch"
import { toast, toastError } from "@bide-comply/ui/components/toaster"
import { cn } from "@bide-comply/ui/lib/utils"

import { Field, fieldCls, TabBar } from "@/features/insight/ui"
import { fmtDate, fmtDateTime } from "@/lib/format"
import { useParams } from "@/lib/params"
import { useProperty } from "@/lib/property"
import { useMe } from "@/lib/session"

type Options = {
  properties: { id: string; code: string; name: string; trading_since: string | null }[]
  audiences: { key: string; label: string; sections: string[] }[]
  sections: { key: string; label: string }[]
}
type Preview = {
  title: string
  period: string
  audience: string
  dutyholder: string | null
  contents: string[]
  estimate: { pages: number; photos: number; certificates: number; checks: number }
}
type ExportStatus = {
  status: "queued" | "building" | "ready" | "failed"
  pages: number | null
  photos: number | null
  pdf_url: string | null
  zip_url: string | null
  fingerprint: string
  error: string | null
}
type ExportRow = ExportStatus & {
  id: string
  kind: string
  property: string | null
  params: { audience?: string; from?: string; to?: string; sections?: string[]; format?: string }
  by: string | null
  at: string
}
type Scheduled = {
  id: string
  name: string
  schedule: string
  target: string
  enabled: boolean
  kind: string
  last_run_at: string | null
}

type Tab = "pack" | "scheduled" | "past"
type Form = {
  property_id: string
  audience: string
  date_from: string
  date_to: string
  sections: string[]
  format: "pdf_zip" | "pdf"
}

const FOR_WHOM: Record<string, string> = {
  insurer: "an insurer",
  sfrs: "the fire service",
  licensing: "the licensing board",
  dutyholder: "the dutyholder",
  assessor: "the competent assessor",
}

function today(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Europe/London" })
}
function daysAgo(n: number): string {
  return new Date(Date.now() - n * 86400000).toLocaleDateString("en-CA", { timeZone: "Europe/London" })
}

export function ReportsPage() {
  const me = useMe().data
  const [params, set] = useParams()
  if (!me?.can["export.pack"])
    return <NoPermission message="Reports and packs are for directors, admins and the competent assessor." />
  const tab = (params.tab as Tab | undefined) ?? "pack"
  return (
    <div className="flex flex-col gap-4">
      <PageHeader title="Reports and packs" subtitle="Make a pack for an inspector or insurer in two minutes." />
      <TabBar<Tab>
        label="Reports"
        value={tab}
        onChange={(v) => set({ tab: v === "pack" ? undefined : v })}
        options={[
          { value: "pack", label: "Inspection pack" },
          { value: "scheduled", label: "Scheduled reports" },
          { value: "past", label: "Past exports" },
        ]}
      />
      {tab === "pack" && (
        <PackBuilder onShowScheduled={() => set({ tab: "scheduled" })} onShowPast={() => set({ tab: "past" })} />
      )}
      {tab === "scheduled" && <ScheduledTab />}
      {tab === "past" && <PastExports />}
    </div>
  )
}

/* ---------------------------------------------------------------- pack builder */

function PackBuilder({ onShowScheduled, onShowPast }: { onShowScheduled: () => void; onShowPast: () => void }) {
  const [params] = useParams()
  const { propertyId } = useProperty()
  const opts = useQuery<Options, ApiError>({
    queryKey: ["reports", "options"],
    queryFn: () => api.get<Options>("/api/reports/options"),
  })
  const [form, setForm] = React.useState<Form | null>(null)

  // Start from the property in the URL (?property=), then the property switcher, then the first property.
  React.useEffect(() => {
    if (!opts.data || form) return
    const o = opts.data
    const p =
      o.properties.find((x) => x.id === params.property) ??
      o.properties.find((x) => x.id === propertyId) ??
      o.properties[0]
    if (!p) return
    const aud = o.audiences[0]
    setForm({
      property_id: p.id,
      audience: aud?.key ?? "insurer",
      date_from: p.trading_since ?? daysAgo(90),
      date_to: today(),
      sections: aud?.sections ?? [],
      format: "pdf_zip",
    })
  }, [opts.data, form, params.property, propertyId])

  if (opts.isPending) return <LoadingPage />
  if (opts.error)
    return opts.error.status === 403 ? (
      <NoPermission />
    ) : (
      <ErrorState message={opts.error.message} onRetry={() => void opts.refetch()} />
    )
  if (opts.data.properties.length === 0)
    return (
      <EmptyState title="No properties to report on">
        You can make a pack once you have access to a property.
      </EmptyState>
    )
  if (!form) return <LoadingPage />
  return (
    <PackForm o={opts.data} form={form} setForm={setForm} onShowScheduled={onShowScheduled} onShowPast={onShowPast} />
  )
}

function PackForm({
  o,
  form,
  setForm,
  onShowScheduled,
  onShowPast,
}: {
  o: Options
  form: Form
  setForm: (f: Form) => void
  onShowScheduled: () => void
  onShowPast: () => void
}) {
  const qc = useQueryClient()
  const coverRef = React.useRef<HTMLDivElement>(null)
  const prop = o.properties.find((p) => p.id === form.property_id)
  const valid = form.sections.length > 0 && !!form.date_from && !!form.date_to && form.date_from <= form.date_to
  const preview = useQuery<Preview, ApiError>({
    queryKey: ["reports", "preview", form],
    queryFn: () => api.post<Preview>("/api/reports/preview", form),
    enabled: valid,
    placeholderData: (prev) => prev,
  })
  const [exportId, setExportId] = React.useState<string | null>(null)
  const build = useMutation({
    mutationFn: () => api.post<{ id: string }>("/api/reports/packs", form),
    onSuccess: (r) => setExportId(r.id),
    onError: (e: ApiError) => toastError(e.message),
  })
  const status = useQuery<ExportStatus, ApiError>({
    queryKey: ["reports", "export", exportId],
    queryFn: () => api.get<ExportStatus>(`/api/reports/exports/${exportId}`),
    enabled: !!exportId,
    refetchInterval: (q) => (q.state.data && ["ready", "failed"].includes(q.state.data.status) ? false : 1500),
  })
  const st = status.data?.status
  React.useEffect(() => {
    if (st === "ready") {
      toast("Your pack is ready to download.")
      void qc.invalidateQueries({ queryKey: ["reports", "exports"] })
    } else if (st === "failed") toastError("The pack couldn't be built. Nothing was sent. Try again.")
  }, [st, qc])

  const update = (patch: Partial<Form>) => {
    setExportId(null)
    setForm({ ...form, ...patch })
  }
  const setAudience = (key: string) =>
    update({ audience: key, sections: o.audiences.find((a) => a.key === key)?.sections ?? form.sections })
  const toggle = (key: string, on: boolean) =>
    update({
      sections: on
        ? o.sections.map((s) => s.key).filter((k) => k === key || form.sections.includes(k))
        : form.sections.filter((k) => k !== key),
    })

  const busy = build.isPending || (!!exportId && (!st || st === "queued" || st === "building"))
  const head = "flex items-center gap-3 border-b border-divider px-4 py-3"

  return (
    <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
      <section className="rounded-[10px] border border-divider bg-surface" aria-label="Pack builder">
        <div className={head}>
          <h2 className="m-0 text-[14px] font-semibold">1. Who is it for, and what period?</h2>
        </div>
        <div className="grid gap-4 p-4 sm:grid-cols-2">
          <Field label="Property" htmlFor="pk-property">
            <select
              id="pk-property"
              className={fieldCls}
              value={form.property_id}
              onChange={(e) => {
                const p = o.properties.find((x) => x.id === e.target.value)
                update({ property_id: e.target.value, date_from: p?.trading_since ?? form.date_from })
              }}
            >
              {o.properties.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Prepared for" htmlFor="pk-audience">
            <select
              id="pk-audience"
              className={fieldCls}
              value={form.audience}
              onChange={(e) => setAudience(e.target.value)}
            >
              {o.audiences.map((a) => (
                <option key={a.key} value={a.key}>
                  {a.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="From" htmlFor="pk-from">
            <input
              id="pk-from"
              type="date"
              className={fieldCls}
              value={form.date_from}
              max={form.date_to}
              onChange={(e) => update({ date_from: e.target.value })}
            />
            {prop?.trading_since === form.date_from && (
              <span className="text-xs text-muted-foreground">Opening day, {fmtDate(form.date_from, true)}</span>
            )}
          </Field>
          <Field label="To" htmlFor="pk-to">
            <input
              id="pk-to"
              type="date"
              className={fieldCls}
              value={form.date_to}
              min={form.date_from}
              max={today()}
              onChange={(e) => update({ date_to: e.target.value })}
            />
            {form.date_to === today() && (
              <span className="text-xs text-muted-foreground">Today, {fmtDate(form.date_to, true)}</span>
            )}
          </Field>
          {form.date_from > form.date_to && (
            <p role="alert" className="m-0 text-[13px] text-st-red sm:col-span-2">
              The end date is before the start date.
            </p>
          )}
        </div>

        <div className={cn(head, "border-t")}>
          <h2 className="m-0 text-[14px] font-semibold">2. What to include</h2>
          <span className="ml-auto text-[13px] text-muted-foreground">
            Pre-ticked for {FOR_WHOM[form.audience] ?? "this audience"}
          </span>
        </div>
        <fieldset className="m-0 grid gap-2.5 border-0 p-4 sm:grid-cols-2">
          <legend className="sr-only">What to include</legend>
          {o.sections.map((s) => {
            const id = `pk-s-${s.key}`
            const on = form.sections.includes(s.key)
            return (
              <label
                key={s.key}
                htmlFor={id}
                className={cn(
                  "flex h-10 cursor-pointer items-center gap-3 rounded-lg border px-3.5 text-[14px]",
                  on ? "border-border" : "border-divider",
                )}
              >
                <Checkbox id={id} checked={on} onCheckedChange={(v) => toggle(s.key, v === true)} />
                {s.label}
              </label>
            )
          })}
          {form.sections.length === 0 && (
            <p role="alert" className="m-0 text-[13px] text-st-red sm:col-span-2">
              Choose what to include.
            </p>
          )}
        </fieldset>

        <div className={cn(head, "border-t")}>
          <h2 className="m-0 text-[14px] font-semibold">3. Format</h2>
        </div>
        <div className="flex flex-wrap items-center gap-2.5 p-4">
          <div role="radiogroup" aria-label="Format" className="flex flex-wrap gap-2.5">
            {(
              [
                ["pdf_zip", "PDF summary + ZIP of evidence"],
                ["pdf", "PDF summary only"],
              ] as const
            ).map(([v, label]) => (
              <label
                key={v}
                className={cn(
                  "flex h-10 cursor-pointer items-center gap-2.5 rounded-lg border px-3.5 text-[14px]",
                  form.format === v ? "border-border" : "border-divider",
                )}
              >
                <input
                  type="radio"
                  name="pk-format"
                  value={v}
                  checked={form.format === v}
                  onChange={() => update({ format: v })}
                  className="size-4 accent-[var(--c-foreground)]"
                />
                {label}
              </label>
            ))}
          </div>
          <span className="ml-auto flex gap-2">
            <Button
              variant="outline"
              disabled={!valid}
              onClick={() => {
                void preview.refetch()
                coverRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" })
                coverRef.current?.focus()
              }}
            >
              Preview
            </Button>
            <Button disabled={!valid || busy} onClick={() => build.mutate()}>
              {busy && <Loader2 className="animate-spin" aria-hidden />}
              {busy ? "Building pack" : "Build pack"}
            </Button>
          </span>
        </div>
        {exportId && (
          <BuildResult s={status.data} error={status.error} onRetry={() => build.mutate()} onShowPast={onShowPast} />
        )}
      </section>

      <div className="flex flex-col gap-4">
        <Cover
          ref={coverRef}
          preview={preview.data}
          loading={preview.isFetching && !preview.data}
          error={preview.error}
          valid={valid}
        />
        <ScheduledCard onManage={onShowScheduled} />
      </div>
    </div>
  )
}

function BuildResult({
  s,
  error,
  onRetry,
  onShowPast,
}: {
  s?: ExportStatus
  error: ApiError | null
  onRetry: () => void
  onShowPast: () => void
}) {
  if (error)
    return (
      <div className="border-t border-divider p-4">
        <ErrorState message={error.message} onRetry={onRetry} />
      </div>
    )
  return (
    <div
      aria-live="polite"
      className="flex flex-wrap items-center gap-3 border-t border-divider bg-background px-4 py-3 text-[13.5px]"
    >
      {!s || s.status === "queued" || s.status === "building" ? (
        <>
          <Loader2 className="size-4 animate-spin text-muted-foreground" aria-hidden />
          <span>Building your pack. Every page is stamped with the export time and a fingerprint.</span>
        </>
      ) : s.status === "failed" ? (
        <>
          <span className="text-st-red">The pack couldn't be built.</span>
          <Button size="sm" variant="outline" onClick={onRetry}>
            Try again
          </Button>
        </>
      ) : (
        <>
          <Pill tone="green">Ready</Pill>
          <span className="text-muted-foreground tabular">
            {s.pages} pages · {s.photos} photos · fingerprint <span className="mono-id">{s.fingerprint}</span>
          </span>
          <span className="ml-auto flex gap-2">
            {s.pdf_url && (
              <Button size="sm" asChild>
                <a href={s.pdf_url} download>
                  <Download aria-hidden /> Download PDF
                </a>
              </Button>
            )}
            {s.zip_url && (
              <Button size="sm" variant="outline" asChild>
                <a href={s.zip_url} download>
                  <Download aria-hidden /> Evidence ZIP
                </a>
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={onShowPast}>
              Past exports
            </Button>
          </span>
        </>
      )}
    </div>
  )
}

const Cover = React.forwardRef<
  HTMLDivElement,
  { preview?: Preview; loading: boolean; error: ApiError | null; valid: boolean }
>(function Cover({ preview, loading, error, valid }, ref) {
  const forWhom = preview ? (/\(([^)]+)\)/.exec(preview.audience)?.[1] ?? preview.audience) : ""
  const [name, ...rest] = preview?.title.split(", ") ?? []
  return (
    <section
      aria-labelledby="cover-h"
      ref={ref}
      tabIndex={-1}
      className="rounded-[10px] border border-divider bg-surface p-4 outline-none"
    >
      <h2 id="cover-h" className="m-0 mb-3 text-[13px] font-medium text-muted-foreground">
        Cover page preview
      </h2>
      {!valid ? (
        <p className="m-0 text-[13px] text-muted-foreground">
          Choose a period and at least one section to see the cover page.
        </p>
      ) : error ? (
        <p className="m-0 text-[13px] text-st-red">{error.message}</p>
      ) : loading || !preview ? (
        <LoadingRows rows={4} label="Loading preview" />
      ) : (
        <>
          <div className="flex min-h-[380px] flex-col rounded-lg border border-border p-5 shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
            <div className="flex items-center gap-2 text-[14px] font-semibold">
              <Mark size={22} /> bide Comply
            </div>
            <div className="mt-6 text-[19px] leading-snug font-semibold tracking-[-0.01em]">
              {[name, ...rest].join(", ")}
              <br />
              Compliance record
            </div>
            <div className="mt-2.5 text-[13.5px] text-muted-foreground">
              {preview.period} · prepared for {forWhom}
            </div>
            {preview.dutyholder && (
              <div className="mt-2.5 text-[13.5px] text-muted-foreground">Dutyholder: {preview.dutyholder}</div>
            )}
            <div className="mt-auto pt-6 text-[12.5px]">
              Contents: {preview.contents.map((c) => shortSection(c)).join(" · ")}
            </div>
            <div className="mt-2 text-[12.5px] text-muted-foreground">
              Every page stamped with export time and a fingerprint, so changes can be detected.
            </div>
          </div>
          <p className="m-0 mt-3 text-[13px] text-muted-foreground tabular">
            Estimated: {preview.estimate.pages} pages, {preview.estimate.photos} photos, {preview.estimate.certificates}{" "}
            {preview.estimate.certificates === 1 ? "certificate" : "certificates"}.
          </p>
        </>
      )}
    </section>
  )
})

function shortSection(label: string): string {
  const map: Record<string, string> = {
    "Fire safety checks and log": "fire checks",
    "Certificates on file": "certificates",
    "Open Actions and Advisories": "open actions",
    "Alarm events and false alarms": "alarm events",
    "Water and legionella records": "water records",
    "Staff training records": "training",
    "Signed FRA and sign-offs": "sign-offs",
    "Audit trail (who did what, when)": "audit trail",
  }
  return map[label] ?? label.toLowerCase()
}

/* ---------------------------------------------------------------- scheduled */

function useScheduled() {
  return useQuery<{ rows: Scheduled[] }, ApiError>({
    queryKey: ["reports", "scheduled"],
    queryFn: () => api.get("/api/reports/scheduled"),
  })
}

function ScheduledCard({ onManage }: { onManage: () => void }) {
  const q = useScheduled()
  return (
    <Card
      title="Scheduled"
      action={
        <button type="button" className="text-link hover:underline" onClick={onManage}>
          Manage
        </button>
      }
    >
      {q.isPending ? (
        <LoadingRows rows={2} />
      ) : q.error ? (
        <ErrorState message={q.error.message} onRetry={() => void q.refetch()} />
      ) : q.data.rows.length === 0 ? (
        <p className="m-0 p-4 text-[13px] text-muted-foreground">No scheduled reports.</p>
      ) : (
        <ul className="m-0 list-none p-0">
          {q.data.rows.map((r) => (
            <li key={r.id} className="flex items-start gap-3 border-b border-divider px-4 py-3 last:border-b-0">
              <span className="min-w-0 flex-1">
                <span className="block font-semibold">{r.name}</span>
                <span className="block text-[12.5px] text-muted-foreground">
                  {r.schedule} · {r.target}
                </span>
              </span>
              <Pill tone={r.enabled ? "green" : "grey"}>{r.enabled ? "On" : "Off"}</Pill>
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}

function ScheduledTab() {
  const me = useMe().data
  const qc = useQueryClient()
  const q = useScheduled()
  const canEdit = !!me?.can["settings.view"]
  const toggle = useMutation({
    mutationFn: (v: { id: string; enabled: boolean }) =>
      api.patch(`/api/reports/scheduled/${v.id}`, { enabled: v.enabled }),
    onMutate: (v) => {
      qc.setQueryData<{ rows: Scheduled[] }>(["reports", "scheduled"], (d) =>
        d ? { rows: d.rows.map((r) => (r.id === v.id ? { ...r, enabled: v.enabled } : r)) } : d,
      )
    },
    onSuccess: (_r, v) => {
      const name = q.data?.rows.find((r) => r.id === v.id)?.name ?? "Report"
      toast(`${name} turned ${v.enabled ? "on" : "off"}.`, {
        action: { label: "Undo", onClick: () => toggle.mutate({ id: v.id, enabled: !v.enabled }) },
      })
    },
    onError: (e: ApiError) => {
      toastError(e.message)
      void qc.invalidateQueries({ queryKey: ["reports", "scheduled"] })
    },
  })
  return (
    <Card
      title="Scheduled reports"
      action={<span className="text-muted-foreground">Sent automatically. Turn one off to pause it.</span>}
    >
      {q.isPending ? (
        <LoadingRows rows={3} />
      ) : q.error ? (
        <ErrorState message={q.error.message} onRetry={() => void q.refetch()} />
      ) : q.data.rows.length === 0 ? (
        <EmptyState title="No scheduled reports">
          The Monday digest and monthly dutyholder packs appear here once set up.
        </EmptyState>
      ) : (
        <ul className="m-0 list-none p-0">
          {q.data.rows.map((r) => (
            <li key={r.id} className="flex items-center gap-4 border-b border-divider px-4 py-3.5 last:border-b-0">
              <FileText className="size-5 shrink-0 text-muted-foreground" aria-hidden />
              <span className="min-w-0 flex-1">
                <span className="block font-semibold">{r.name}</span>
                <span className="block text-[13px] text-muted-foreground">
                  {r.schedule} · {r.target}
                  {r.last_run_at ? ` · last sent ${fmtDateTime(r.last_run_at)}` : " · not sent yet"}
                </span>
              </span>
              <label className="flex items-center gap-2 text-[13px]" htmlFor={`sch-${r.id}`}>
                <span className={r.enabled ? "text-st-green" : "text-muted-foreground"}>
                  {r.enabled ? "On" : "Off"}
                </span>
                <Switch
                  id={`sch-${r.id}`}
                  aria-label={`${r.name}: ${r.enabled ? "on" : "off"}`}
                  checked={r.enabled}
                  disabled={!canEdit}
                  onCheckedChange={(v) => toggle.mutate({ id: r.id, enabled: v })}
                />
              </label>
            </li>
          ))}
        </ul>
      )}
      {!canEdit && (
        <p className="m-0 border-t border-divider px-4 py-3 text-xs text-muted-foreground">
          Only admins can turn scheduled reports on or off.
        </p>
      )}
    </Card>
  )
}

/* ---------------------------------------------------------------- past exports */

function PastExports() {
  const q = useQuery<{ rows: ExportRow[] }, ApiError>({
    queryKey: ["reports", "exports"],
    queryFn: () => api.get("/api/reports/exports"),
  })
  const opts = useQuery<Options, ApiError>({
    queryKey: ["reports", "options"],
    queryFn: () => api.get<Options>("/api/reports/options"),
  })
  const audience = (k?: string) => opts.data?.audiences.find((a) => a.key === k)?.label ?? k ?? ""
  const th = "h-[34px] px-3 text-left text-xs font-medium whitespace-nowrap text-muted-foreground"
  return (
    <Card
      title="Past exports"
      action={
        <span className="text-muted-foreground">
          Download links last a few minutes; reopen this tab for fresh ones.
        </span>
      }
    >
      {q.isPending ? (
        <LoadingRows rows={4} />
      ) : q.error ? (
        <ErrorState message={q.error.message} onRetry={() => void q.refetch()} />
      ) : q.data.rows.length === 0 ? (
        <EmptyState title="No exports yet">
          Packs you build appear here, with who made them and their fingerprint.
        </EmptyState>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-[13.5px]">
            <thead className="bg-background">
              <tr className="border-b border-divider">
                <th scope="col" className={th}>
                  When
                </th>
                <th scope="col" className={th}>
                  Property
                </th>
                <th scope="col" className={th}>
                  Prepared for
                </th>
                <th scope="col" className={th}>
                  Period
                </th>
                <th scope="col" className={cn(th, "text-right")}>
                  Pages
                </th>
                <th scope="col" className={th}>
                  By
                </th>
                <th scope="col" className={th}>
                  Fingerprint
                </th>
                <th scope="col" className={th}>
                  <span className="sr-only">Downloads</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {q.data.rows.map((r) => (
                <tr key={r.id} className="h-12 border-b border-divider last:border-b-0">
                  <td className="px-3 whitespace-nowrap">{fmtDateTime(r.at)}</td>
                  <td className="px-3 whitespace-nowrap">{r.property ?? "All properties"}</td>
                  <td className="px-3 whitespace-nowrap">
                    {r.kind === "inspection_pack" ? audience(r.params.audience) : r.kind.replace("_", " ")}
                  </td>
                  <td className="px-3 whitespace-nowrap">
                    {r.params.from && r.params.to ? `${fmtDate(r.params.from)} – ${fmtDate(r.params.to, true)}` : "—"}
                  </td>
                  <td className="tabular px-3 text-right">{r.pages ?? "—"}</td>
                  <td className="px-3 whitespace-nowrap">{r.by ?? "—"}</td>
                  <td className="px-3">
                    <span className="mono-id">{r.fingerprint || "—"}</span>
                  </td>
                  <td className="px-3">
                    <span className="flex justify-end gap-2 whitespace-nowrap">
                      {r.status === "ready" ? (
                        <>
                          {r.pdf_url && (
                            <a href={r.pdf_url} download className="text-link hover:underline">
                              PDF
                            </a>
                          )}
                          {r.zip_url && (
                            <a href={r.zip_url} download className="text-link hover:underline">
                              ZIP
                            </a>
                          )}
                        </>
                      ) : r.status === "failed" ? (
                        <Pill tone="red" title={r.error ?? undefined}>
                          Failed
                        </Pill>
                      ) : (
                        <Pill tone="blue">Building</Pill>
                      )}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  )
}
