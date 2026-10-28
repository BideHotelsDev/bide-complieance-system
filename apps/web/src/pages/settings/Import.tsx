/*
 * Settings › Import data (design: Import, CMS-06). Four steps: upload the BH-CMP-002 workbook or the register Sheet,
 * match its columns, review what will happen (and map role owners to people), then copy it in. Nothing in the
 * workbook changes; it is a one-way copy that can be re-run until go-live. The job id and step live in the URL.
 */
import * as React from "react"
import { Link } from "@tanstack/react-router"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { AlertTriangle, Check, FileSpreadsheet, Upload, X } from "lucide-react"
import { api, ApiError, upload } from "@bide-comply/api-client"
import { Button } from "@bide-comply/ui/components/button"
import { Callout, ErrorState, LoadingRows, NoPermission } from "@bide-comply/ui/components/page"
import { GateItemBadge, Pill, type GateItemStatus } from "@bide-comply/ui/components/status"
import { toastError } from "@bide-comply/ui/components/toaster"
import { cn } from "@bide-comply/ui/lib/utils"

import { errMsg, NativeSelect } from "../../features/settings-a/ui"
import { fmtDateTime, plural } from "../../lib/format"
import { useParams } from "../../lib/params"
import { useMe } from "../../lib/session"

type Sheet = {
  name: string
  kind: "gate" | "actions" | null
  rows: number
  headers: string[]
  property_id: string | null
  property: string | null
}
type Plan = {
  gate_items: number
  properties: string[]
  actions: number
  actions_already_here?: number
  to_confirm: number
  done_without_evidence: string[]
  role_owners: string[]
  unmatched_columns: string[]
  errors: number
  action_range: string | null
  matched: number
  columns: number
}
type Job = {
  id: string
  file_name: string
  status: string
  sheets: Sheet[]
  detected: string
  gate_mapping: { column: string; example: string | null; field: string | null; matched: boolean }[]
  fields: { key: string; label: string }[]
  plan: Plan
  result: Partial<Result>
  status_mapping: { from: string; to: string }[]
  owner_map?: Record<string, string>
}
type Result = {
  gate_created: number
  gate_updated: number
  actions: number
  roles_left_to_map: string[]
  at: string
}

const STEPS = [
  { key: "upload", label: "Upload" },
  { key: "map", label: "Map columns" },
  { key: "review", label: "Review" },
  { key: "import", label: "Import" },
] as const
type Step = (typeof STEPS)[number]["key"]

const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"

export function ImportPage() {
  const me = useMe()
  const [p, set] = useParams()
  const qc = useQueryClient()
  const jobId = p.job
  const job = useQuery({
    queryKey: ["import", jobId],
    queryFn: () => api.get<Job>(`/api/imports/${jobId}`),
    enabled: !!jobId,
  })
  const j = job.data
  const step: Step = !jobId ? "upload" : j?.status === "imported" ? "import" : ((p.step as Step) ?? "map")
  const go = (s: Step) => set({ step: s === "map" ? undefined : s }, { replace: false })
  const refresh = () => qc.invalidateQueries({ queryKey: ["import", jobId] })

  const mapping = useMutation({
    mutationFn: (body: { gate?: Record<string, string | null>; owner_map?: Record<string, string> }) =>
      api.put(`/api/imports/${jobId}`, body),
    onSuccess: () => void refresh(),
    onError: (e) => toastError(errMsg(e)),
  })
  const run = useMutation({
    mutationFn: () => api.post<Result>(`/api/imports/${jobId}/run`),
    onSuccess: () => {
      void refresh()
      void qc.invalidateQueries({ queryKey: ["gates"] })
      go("import")
    },
    onError: (e) => toastError(errMsg(e)),
  })

  if (me.data && !me.data.can["import.run"]) return <NoPermission />

  const idx = STEPS.findIndex((s) => s.key === step)
  const plan = j?.plan
  const primary =
    step === "map" && plan ? (
      <Button onClick={() => go("review")}>Review {plural(plan.gate_items + plan.actions, "item")}</Button>
    ) : step === "review" && plan ? (
      <Button disabled={run.isPending} onClick={() => run.mutate()}>
        {run.isPending ? "Importing…" : `Import ${plural(plan.gate_items + plan.actions, "item")}`}
      </Button>
    ) : step === "import" ? (
      <Button asChild>
        <Link to="/gates">Open the opening checklists</Link>
      </Button>
    ) : null

  return (
    <div className="-mx-4 -my-5 flex min-h-screen flex-col md:-mx-7 md:-my-6">
      <header className="sticky top-0 z-20 flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-divider bg-surface px-4 py-2.5 md:px-6">
        <Button variant="outline" size="icon-sm" asChild>
          <Link to="/settings/library" aria-label="Close import">
            <X />
          </Link>
        </Button>
        <h1 className="m-0 text-[15px] font-semibold">Import</h1>
        <ol aria-label="Steps" className="m-0 mx-auto flex list-none flex-wrap items-center gap-5 p-0">
          {STEPS.map((s, i) => (
            <li
              key={s.key}
              aria-current={i === idx ? "step" : undefined}
              className={cn(
                "flex items-center gap-2 text-[14px]",
                i === idx ? "font-semibold" : i > idx && "text-muted-foreground",
              )}
            >
              <span
                className={cn(
                  "inline-flex size-[22px] items-center justify-center rounded-full text-xs font-semibold",
                  i < idx && "bg-primary text-primary-foreground",
                  i === idx && "bg-st-blue text-white",
                  i > idx && "border border-border",
                )}
              >
                {i < idx ? <Check className="size-3.5" aria-label="Done" /> : i + 1}
              </span>
              {s.label}
            </li>
          ))}
        </ol>
        <div className="flex items-center gap-2">
          {(step === "map" || step === "review") && (
            <Button
              variant="outline"
              onClick={() =>
                step === "review" ? go("map") : set({ job: undefined, step: undefined }, { replace: false })
              }
            >
              Back
            </Button>
          )}
          {primary}
        </div>
      </header>

      <div className="flex-1 bg-background p-4 md:p-6">
        {step === "upload" ? (
          <UploadStep onStarted={(id) => set({ job: id, step: undefined }, { replace: false })} />
        ) : job.error ? (
          <ErrorState
            message={
              job.error instanceof ApiError && job.error.status === 404
                ? "This import doesn't exist any more."
                : errMsg(job.error)
            }
            onRetry={() => void job.refetch()}
          />
        ) : !j ? (
          <LoadingRows rows={10} />
        ) : step === "import" ? (
          <ResultStep
            job={j}
            result={run.data}
            onAgain={() => set({ job: undefined, step: undefined }, { replace: false })}
          />
        ) : (
          <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
            <div className="flex min-w-0 flex-col gap-4">
              <FileCard job={j} />
              {step === "map" ? (
                <MapTable
                  job={j}
                  busy={mapping.isPending}
                  onChange={(col, field) => mapping.mutate({ gate: { [col]: field } })}
                />
              ) : (
                <ReviewStep job={j} onOwner={(role, id) => mapping.mutate({ owner_map: { [role]: id } })} />
              )}
            </div>
            <WhatWillHappen job={j} />
          </div>
        )}
      </div>
    </div>
  )
}

function UploadStep({ onStarted }: { onStarted: (id: string) => void }) {
  const input = React.useRef<HTMLInputElement>(null)
  const [busy, setBusy] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [over, setOver] = React.useState(false)
  const start = async (f: File) => {
    setError(null)
    const lower = f.name.toLowerCase()
    const type = lower.endsWith(".xlsx") ? XLSX : lower.endsWith(".csv") ? "text/csv" : null
    if (!type) {
      setError("Choose an Excel workbook (.xlsx) or a CSV file.")
      return
    }
    try {
      setBusy(`Uploading ${f.name}…`)
      // Browsers label CSV and XLSX inconsistently, so the type is set from the extension; the server checks the bytes.
      const file = new File([f], f.name, { type })
      const up = await upload(file, { captured_with: "upload", file_name: f.name })
      setBusy("Reading the sheets…")
      const r = await api.post<{ id: string }>("/api/imports", { evidence_id: up.id })
      onStarted(r.id)
    } catch (e) {
      setError(errMsg(e))
    } finally {
      setBusy(null)
    }
  }
  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-4 pt-6">
      <div>
        <h2 className="m-0 text-[20px] font-semibold">Bring in the register Sheet or the gate workbook</h2>
        <p className="m-0 mt-1 text-muted-foreground">
          Upload BH-CMP-002 (the opening checklist workbook), BH-CMP-001, or any XLSX or CSV. We find the sheets, match
          the columns, and show exactly what will happen before anything is copied.
        </p>
      </div>
      <div
        onDragOver={(e) => {
          e.preventDefault()
          setOver(true)
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault()
          setOver(false)
          const f = e.dataTransfer.files[0]
          if (f) void start(f)
        }}
        className={cn(
          "flex flex-col items-center gap-3 rounded-xl border-2 border-dashed bg-surface px-6 py-12 text-center",
          over ? "border-st-blue bg-st-blue-bg" : "border-border",
        )}
      >
        <FileSpreadsheet className="size-8 text-subtle" aria-hidden />
        <div className="font-medium">{busy ?? "Drop the file here"}</div>
        <div className="text-[13px] text-muted-foreground">Excel (.xlsx) or CSV, up to the upload limit</div>
        <input
          ref={input}
          type="file"
          accept=".xlsx,.csv,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          className="sr-only"
          aria-label="Choose a workbook to import"
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) void start(f)
            e.target.value = ""
          }}
        />
        <Button disabled={!!busy} onClick={() => input.current?.click()}>
          <Upload /> Choose a file
        </Button>
      </div>
      {error && (
        <Callout tone="red" icon={<AlertTriangle className="size-4" aria-hidden />}>
          {error}
        </Callout>
      )}
      <ul className="m-0 flex list-disc flex-col gap-1 pl-5 text-[13px] text-muted-foreground">
        <li>Nothing in the workbook is changed. You can re-run the import until go-live.</li>
        <li>"Done" with no evidence filed imports as "To confirm". No evidence, not done.</li>
        <li>Actions & Advisories keep their original IDs.</li>
      </ul>
    </div>
  )
}

function FileCard({ job: j }: { job: Job }) {
  return (
    <section className="flex flex-wrap items-center gap-4 rounded-[10px] border border-divider bg-surface px-4 py-3.5">
      <span className="inline-flex h-10 w-11 shrink-0 items-center justify-center rounded-md bg-st-green-bg text-[11px] font-bold text-st-green">
        {j.file_name.toLowerCase().endsWith(".csv") ? "CSV" : "XLSX"}
      </span>
      <div className="min-w-[200px] flex-1">
        <div className="font-medium break-words">{j.file_name}</div>
        <div className="text-xs text-muted-foreground">
          {plural(j.sheets.length, "sheet")} found · template detected: {j.detected}
        </div>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {j.sheets.map((s) =>
          s.kind === null ? (
            <Pill key={s.name} tone="grey" className="line-through" title="Not imported">
              {s.name} · skipped
            </Pill>
          ) : s.kind === "actions" ? (
            <Pill key={s.name} tone="blue">
              {s.name} · {s.rows}
            </Pill>
          ) : (
            <Pill
              key={s.name}
              tone={s.property ? "grey" : "amber"}
              title={s.property ? `Goes to ${s.property}` : "No matching property"}
            >
              {s.name} · {s.rows}
            </Pill>
          ),
        )}
      </div>
    </section>
  )
}

function MapTable({
  job: j,
  busy,
  onChange,
}: {
  job: Job
  busy: boolean
  onChange: (column: string, field: string | null) => void
}) {
  const gate = j.sheets.find((s) => s.kind === "gate")
  if (!gate)
    return (
      <Callout tone="amber" icon={<AlertTriangle className="size-4" aria-hidden />}>
        No opening checklist sheet was found (a sheet with Ref and Section or Item columns).
        {j.sheets.some((s) => s.kind === "actions") ? " The Actions & Advisories sheet will still import." : ""}
      </Callout>
    )
  const used = new Set(j.gate_mapping.map((m) => m.field).filter(Boolean))
  // Show the columns in the workbook's own order.
  const order = (c: string) => {
    const i = gate.headers.indexOf(c)
    return i < 0 ? 999 : i
  }
  const rows = [...j.gate_mapping].sort((a, b) => order(a.column) - order(b.column))
  return (
    <section aria-labelledby="map-h" className="overflow-hidden rounded-[10px] border border-divider bg-surface">
      <div className="flex flex-wrap items-center gap-3 border-b border-divider px-4 py-3">
        <h2 id="map-h" className="m-0 text-[14px] font-semibold">
          Property sheets → Opening checklist items
        </h2>
        <span className="ml-auto text-xs text-muted-foreground">
          {j.plan.matched} of {j.plan.columns} columns matched automatically
        </span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] border-collapse text-[13.5px]">
          <thead>
            <tr className="text-left text-xs text-muted-foreground">
              <th className="h-[34px] bg-background px-4 font-medium whitespace-nowrap">Column in the workbook</th>
              <th className="bg-background px-3 font-medium">Example ({gate.name})</th>
              <th className="bg-background px-3 font-medium">bide Comply field</th>
              <th className="bg-background px-3 font-medium">Match</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((m) => (
              <tr key={m.column} className={cn("border-t border-divider", !m.matched && "bg-st-amber-bg/40")}>
                <td className="min-w-[160px] px-4 py-2 font-medium">{m.column}</td>
                <td className="max-w-[200px] truncate px-3 text-muted-foreground" title={m.example ?? undefined}>
                  {m.example ? (
                    /^[A-H]\d\d$/.test(m.example) || m.example.length <= 2 ? (
                      <span className="mono-id">{m.example}</span>
                    ) : (
                      m.example
                    )
                  ) : (
                    "(empty)"
                  )}
                </td>
                <td className="px-3 py-1.5">
                  <NativeSelect
                    aria-label={`bide Comply field for ${m.column}`}
                    value={m.field ?? ""}
                    disabled={busy}
                    className={cn("w-[200px]", !m.matched && "border-st-amber")}
                    onChange={(e) => onChange(m.column, e.target.value || null)}
                    options={[
                      { value: "", label: m.matched ? "Don't import" : "Choose a field" },
                      ...j.fields.map((f) => ({
                        value: f.key,
                        label: f.key === "status" ? `${f.label} · ${j.status_mapping.length} values mapped` : f.label,
                        disabled: used.has(f.key) && f.key !== m.field,
                      })),
                    ]}
                  />
                </td>
                <td className="px-3">
                  {m.matched ? <Pill tone="green">Matched</Pill> : <Pill tone="amber">Needs a choice</Pill>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="m-0 border-t border-divider px-4 py-2.5 text-xs text-muted-foreground">
        Columns left on "Choose a field" are not imported. Every property sheet uses the same columns.
      </p>
    </section>
  )
}

function ReviewStep({ job: j, onOwner }: { job: Job; onOwner: (role: string, personId: string) => void }) {
  const owners = useQuery({
    queryKey: ["import-owners"],
    queryFn: () => api.get<{ people: { id: string; name: string }[] }>("/api/imports/options/owners"),
  })
  const [chosen, setChosen] = React.useState<Record<string, string>>(j.owner_map ?? {})
  const gateSheets = j.sheets.filter((s) => s.kind === "gate")
  return (
    <>
      <section className="overflow-hidden rounded-[10px] border border-divider bg-surface">
        <div className="border-b border-divider px-4 py-3">
          <h2 className="m-0 text-[14px] font-semibold">Where each sheet goes</h2>
        </div>
        <ul className="m-0 list-none p-0">
          {j.sheets.map((s) => (
            <li
              key={s.name}
              className="flex flex-wrap items-center gap-3 border-b border-divider px-4 py-2.5 text-[13.5px] last:border-0"
            >
              <span className="min-w-[180px] font-medium">{s.name}</span>
              <span className="text-muted-foreground">→</span>
              {s.kind === "gate" ? (
                s.property ? (
                  <span>
                    {s.property} opening checklist · {plural(s.rows, "row")}
                  </span>
                ) : (
                  <span className="text-st-amber">No property is called “{s.name}”, so this sheet is skipped</span>
                )
              ) : s.kind === "actions" ? (
                <span>Actions & Advisories · {plural(s.rows, "row")}, matched to properties by ID</span>
              ) : (
                <span className="text-muted-foreground">Skipped</span>
              )}
            </li>
          ))}
        </ul>
        {gateSheets.length === 0 && (
          <p className="m-0 px-4 py-3 text-[13px] text-muted-foreground">No opening checklist sheets in this file.</p>
        )}
      </section>
      <section className="overflow-hidden rounded-[10px] border border-divider bg-surface">
        <div className="flex flex-wrap items-center gap-3 border-b border-divider px-4 py-3">
          <h2 className="m-0 text-[14px] font-semibold">Action owners that are roles, not people</h2>
          <span className="ml-auto text-xs text-muted-foreground">One name per item (golden rule 2)</span>
        </div>
        {j.plan.role_owners.length === 0 ? (
          <p className="m-0 px-4 py-3 text-[13px] text-muted-foreground">
            Every owner in the file matches a person. Nothing to map.
          </p>
        ) : (
          <table className="w-full border-collapse text-[13.5px]">
            <thead>
              <tr className="text-left text-xs text-muted-foreground">
                <th className="h-[34px] bg-background px-4 font-medium">Owner in the workbook</th>
                <th className="bg-background px-3 font-medium">Person in bide Comply</th>
              </tr>
            </thead>
            <tbody>
              {j.plan.role_owners.map((o) => (
                <tr key={o} className="border-t border-divider">
                  <td className="px-4 py-2 font-medium">“{o}”</td>
                  <td className="px-3 py-1.5">
                    <NativeSelect
                      aria-label={`Person for ${o}`}
                      className="w-[260px]"
                      value={chosen[o] ?? ""}
                      onChange={(e) => {
                        setChosen((c) => ({ ...c, [o]: e.target.value }))
                        if (e.target.value) onOwner(o, e.target.value)
                      }}
                      options={(owners.data?.people ?? []).map((p) => ({ value: p.id, label: p.name }))}
                      placeholder="Leave as text for now"
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="m-0 border-t border-divider px-4 py-2.5 text-xs text-muted-foreground">
          Owners left as text import as written and show on the Actions list as "needs an owner".
        </p>
      </section>
    </>
  )
}

function Row({
  n,
  tone = "grey",
  children,
}: {
  n: React.ReactNode
  tone?: "grey" | "green" | "amber" | "red"
  children: React.ReactNode
}) {
  return (
    <li className="flex gap-3 border-b border-divider px-4 py-3 text-[13.5px] last:border-0">
      <Pill tone={tone} className="tabular">
        {n}
      </Pill>
      <div className="min-w-0 flex-1">{children}</div>
    </li>
  )
}

function WhatWillHappen({ job: j }: { job: Job }) {
  const p = j.plan
  const unmapped = p.role_owners.filter((o) => !j.owner_map?.[o])
  return (
    <aside
      aria-label="Checks before import"
      className="self-start overflow-hidden rounded-[10px] border border-divider bg-surface xl:sticky xl:top-16"
    >
      <h2 className="m-0 border-b border-divider px-4 py-3 text-[14px] font-semibold">What will happen</h2>
      <ul className="m-0 list-none p-0">
        <Row n={p.gate_items} tone="green">
          Gate items across {plural(p.properties.length, "property", "properties")}
          {p.actions > 0 && (
            <>
              , plus {p.actions} Actions & Advisories with their original IDs
              {p.action_range ? ` (${p.action_range})` : ""}
            </>
          )}
          .
        </Row>
        {!!p.actions_already_here && (
          <Row n={p.actions_already_here} tone="grey">
            Actions already here from an earlier import are left as they are, so re-running never duplicates one.
          </Row>
        )}
        {p.to_confirm > 0 && (
          <Row n={p.to_confirm} tone="amber">
            <strong>"To confirm" items import as open.</strong> They count against Class A until evidence is filed.
          </Row>
        )}
        {p.done_without_evidence.length > 0 && (
          <Row n={p.done_without_evidence.length} tone="amber">
            <strong>Done with no evidence:</strong> {p.done_without_evidence.slice(0, 4).join(", ")}
            {p.done_without_evidence.length > 4 ? ` and ${p.done_without_evidence.length - 4} more` : ""}{" "}
            {p.done_without_evidence.length === 1 ? "has" : "have"} no evidence link and import as "To confirm" until it
            is attached. No evidence, not done.
          </Row>
        )}
        {unmapped.length > 0 && (
          <Row n="Owners" tone="red">
            <strong>Action owners that are roles, not people</strong> (
            {unmapped
              .slice(0, 4)
              .map((o) => `“${o}”`)
              .join(", ")}
            {unmapped.length > 4 ? ", …" : ""}). Map each to a person in the review step.
          </Row>
        )}
        {p.unmatched_columns.length > 0 && (
          <Row n={p.unmatched_columns.length} tone="amber">
            {p.unmatched_columns.length === 1 ? "Column" : "Columns"} not imported:{" "}
            {p.unmatched_columns.map((c) => `“${c}”`).join(", ")}.
          </Row>
        )}
        <Row n={p.errors} tone={p.errors ? "red" : "grey"}>
          Errors. Nothing in the workbook is changed; this is a one-way copy you can re-run until go-live.
        </Row>
      </ul>
      <div className="border-t border-divider bg-background px-4 py-3">
        <div className="mb-2 text-xs font-semibold">Status value mapping</div>
        <dl className="m-0 grid grid-cols-[1fr_auto_1.3fr] items-center gap-x-3 gap-y-1.5 text-[12.5px]">
          {j.status_mapping.map((s) => {
            const key = {
              Done: "done",
              "In progress": "in_progress",
              "Not started": "not_started",
              "To confirm": "to_confirm",
              "N/A": "na",
            }[s.from] as GateItemStatus | undefined
            const extra = s.to.replace(s.from, "").trim()
            return (
              <React.Fragment key={s.from}>
                <dt>{s.from}</dt>
                <span aria-hidden className="text-muted-foreground">
                  →
                </span>
                <dd className="m-0 flex flex-wrap items-center gap-1.5">
                  {key ? <GateItemBadge status={key} /> : s.to}
                  {extra && <span className="text-muted-foreground">{extra}</span>}
                </dd>
              </React.Fragment>
            )
          })}
        </dl>
      </div>
    </aside>
  )
}

function ResultStep({ job: j, result, onAgain }: { job: Job; result?: Result; onAgain: () => void }) {
  const r = result ?? (j.result.at ? (j.result as Result) : null)
  if (!r) return <LoadingRows rows={4} />
  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-4 pt-4">
      <div className="flex items-center gap-3">
        <span className="inline-flex size-9 items-center justify-center rounded-full bg-st-green-bg text-st-green">
          <Check className="size-5" aria-hidden />
        </span>
        <div>
          <h2 className="m-0 text-[20px] font-semibold">Imported {j.file_name}</h2>
          <div className="text-[13px] text-muted-foreground">
            {fmtDateTime(r.at)} · a one-way copy; re-run it until go-live
          </div>
        </div>
      </div>
      <div className="grid grid-cols-3 gap-3">
        {[
          { label: "Gate items updated", n: r.gate_updated },
          { label: "Gate items added", n: r.gate_created },
          { label: "Actions & Advisories added", n: r.actions },
        ].map((k) => (
          <div key={k.label} className="rounded-[10px] border border-divider bg-surface p-4">
            <div className="text-[12.5px] text-muted-foreground">{k.label}</div>
            <div className="tabular mt-1 text-[26px] leading-none font-semibold">{k.n}</div>
          </div>
        ))}
      </div>
      {r.roles_left_to_map.length > 0 && (
        <Callout tone="amber" icon={<AlertTriangle className="size-4" aria-hidden />}>
          {plural(r.roles_left_to_map.length, "owner")} imported as text, not a person:{" "}
          {r.roles_left_to_map.map((o) => `“${o}”`).join(", ")}. Give each Action a real owner on the Actions list.
        </Callout>
      )}
      <p className="m-0 text-[13px] text-muted-foreground">
        Actions whose IDs were already in bide Comply were left alone, so running the import again doesn't duplicate
        them.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button asChild>
          <Link to="/gates">Open the opening checklists</Link>
        </Button>
        <Button variant="outline" asChild>
          <Link to="/actions">Actions to fix</Link>
        </Button>
        <Button variant="outline" onClick={onAgain}>
          Import another file
        </Button>
      </div>
    </div>
  )
}
