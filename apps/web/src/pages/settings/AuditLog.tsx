/*
 * Audit log (AUD-01, design: AuditLog). Read only: every change in order, with what changed and the hash chain that
 * proves nothing was edited afterwards. The nightly job checks the chain; anyone who can see the log can re-check it.
 */
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Check, ChevronDown, ChevronRight, ShieldAlert } from "lucide-react"
import * as React from "react"
import { Popover as PopoverPrimitive } from "radix-ui"

import { api, download, type ApiError } from "@bide-comply/api-client"
import { FacetButton, SearchBox, Summary, type Facet } from "@bide-comply/ui/components/filter-bar"
import { Pagination } from "@bide-comply/ui/components/data-table"
import { EmptyState, ErrorState, LoadingRows, NoPermission, PageHeader } from "@bide-comply/ui/components/page"
import { toast } from "@bide-comply/ui/components/toaster"
import { cn } from "@bide-comply/ui/lib/utils"

import { errText } from "../../features/settings-b/ui"
import { fmtDate, fmtTime } from "../../lib/format"
import { list, useParams } from "../../lib/params"
import { useMe } from "../../lib/session"

type Change = { field: string; before: unknown; after: unknown }
type Row = {
  id: string
  seq: number
  at: string
  time: string
  date: string
  who: string
  actor_id: string | null
  what: string
  record: string
  from: string
  category: string
  action: string
  code: string | null
  flag: boolean
  changes: Change[]
  hash: string
  prev_hash: string | null
}
type AuditData = {
  rows: Row[]
  total: number
  page: number
  page_size: number
  facets: Facet[]
  summary: string
  any_filter: boolean
  categories: { key: string; label: string }[]
  chain: { checked_at: string; intact: boolean } | null
}

const WHEN = [
  { value: "today", label: "Today" },
  { value: "7d", label: "Last 7 days" },
  { value: "30d", label: "Last 30 days" },
  { value: "all", label: "All time" },
]
const short = (h: string | null) => (h ? `${h.slice(0, 4)}…${h.slice(-4)}` : "none")
const isRef = (s: string) => /^[A-Z]{1,6}-\d{2,}$/.test(s)

function fmtValue(v: unknown): string {
  if (v === null || v === undefined || v === "") return "empty"
  if (typeof v === "string") return v
  if (typeof v === "number" || typeof v === "boolean") return String(v)
  if (Array.isArray(v)) return v.map(fmtValue).join(", ")
  return JSON.stringify(v)
}

export function AuditLogPage() {
  const me = useMe()
  const qc = useQueryClient()
  const [params, set] = useParams()
  const category = params.category ?? "all"
  const when = params.when ?? "today"
  const page = Number(params.page ?? 1)
  const [open, setOpen] = React.useState<Set<string>>(new Set())

  const q = useQuery<AuditData, ApiError>({
    queryKey: ["settings", "audit", category, params.q, params.person_id, params.prop, when, page],
    queryFn: () =>
      api.get<AuditData>("/api/settings/audit", {
        category,
        q: params.q,
        person_id: list(params.person_id),
        prop: list(params.prop),
        when,
        page,
      }),
    placeholderData: keepPreviousData,
    enabled: !!me.data?.can["audit.view"],
  })

  const verify = useMutation<{ intact: boolean; events: number; broken_at: number | null }, ApiError>({
    mutationFn: () => api.post("/api/settings/audit/verify"),
    onSuccess: (r) => {
      if (r.intact) toast.success(`Checked ${r.events} events. The chain is intact.`)
      else toast.error(`The chain is broken at event ${r.broken_at}. Tell the technical admin now.`)
      void qc.invalidateQueries({ queryKey: ["settings", "audit"] })
    },
    onError: (e) => toast.error(errText(e)),
  })

  const [exporting, setExporting] = React.useState(false)
  const doExport = async () => {
    if (!q.data) return
    setExporting(true)
    try {
      await download(
        "/api/export",
        {
          name: "Audit log",
          format: "csv",
          columns: [
            { key: "date", label: "Date" },
            { key: "time", label: "Time" },
            { key: "who", label: "Who" },
            { key: "what", label: "What happened" },
            { key: "record", label: "Record" },
            { key: "from", label: "From" },
            { key: "hash", label: "Fingerprint" },
          ],
          rows: q.data.rows,
        },
        "Audit log.csv",
      )
      toast.success(`Exported ${q.data.rows.length} events. The export is in the audit log too.`)
      void qc.invalidateQueries({ queryKey: ["settings", "audit"] })
    } catch (e) {
      toast.error(errText(e))
    } finally {
      setExporting(false)
    }
  }

  if (me.data && !me.data.can["audit.view"]) return <NoPermission />

  const d = q.data
  const toggle = (id: string) =>
    setOpen((s) => {
      const n = new Set(s)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Audit log"
        subtitle="Every change, in order. Nothing here can be edited or deleted."
        actions={
          <>
            <ChainChip chain={d?.chain} loading={!d} checking={verify.isPending} onCheck={() => verify.mutate()} />
            <button
              type="button"
              disabled={!d || d.rows.length === 0 || exporting}
              onClick={() => void doExport()}
              className="inline-flex h-9 items-center rounded-md border border-border bg-surface px-3.5 text-[13.5px] font-medium hover:bg-hover disabled:opacity-40"
            >
              {exporting ? "Exporting…" : "Export"}
            </button>
          </>
        }
      />

      <div role="tablist" aria-label="Category" className="flex gap-1.5 overflow-x-auto pb-0.5 [scrollbar-width:none]">
        {(d?.categories ?? [{ key: "all", label: "Everything" }]).map((c) => (
          <button
            key={c.key}
            role="tab"
            type="button"
            aria-selected={category === c.key}
            onClick={() => set({ category: c.key === "all" ? undefined : c.key, page: undefined })}
            className={cn(
              "inline-flex h-9 shrink-0 items-center rounded-full border px-3.5 text-[13.5px] font-medium transition-colors",
              category === c.key
                ? "border-primary bg-primary text-primary-foreground"
                : "border-border bg-surface text-ink2 hover:bg-hover",
            )}
          >
            {c.label}
          </button>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <SearchBox
          value={params.q ?? ""}
          onChange={(v) => set({ q: v || undefined, page: undefined })}
          placeholder="Search by person, ID or record"
          count={d && params.q ? d.total : null}
          className="h-9 w-[280px]"
        />
        {(d?.facets ?? []).map((f) => (
          <FacetButton
            key={f.key}
            facet={{ ...f, value: f.key === "person_id" && !f.active ? "Anyone" : f.value }}
            onChange={(v) => set({ [f.key]: v.join(",") || undefined, page: undefined })}
          />
        ))}
        <WhenButton value={when} onChange={(v) => set({ when: v === "today" ? undefined : v, page: undefined })} />
        {d?.any_filter && (
          <button
            type="button"
            onClick={() => set({ q: undefined, person_id: undefined, prop: undefined, page: undefined })}
            className="h-8 rounded-md px-2 text-[13px] text-link hover:bg-hover"
          >
            Clear all filters
          </button>
        )}
      </div>

      {d && <Summary className="text-[13.5px] text-foreground">{d.summary}</Summary>}

      <div className="overflow-hidden rounded-[10px] border border-divider bg-surface">
        {q.isError ? (
          <ErrorState message={q.error.message} onRetry={() => void q.refetch()} />
        ) : !d ? (
          <LoadingRows rows={6} label="Loading the audit log" />
        ) : d.rows.length === 0 ? (
          <EmptyState title="No events match">
            {when === "today"
              ? "Nothing matches today yet. Try the last 7 days."
              : "Try fewer filters or a longer period."}
          </EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className={cn("w-full border-collapse text-[13.5px]", q.isFetching && "opacity-70")}>
              <thead>
                <tr className="text-left text-[12.5px] text-muted-foreground">
                  <th className="h-[38px] w-12 border-b border-divider px-3.5 font-medium">
                    <span className="sr-only">Details</span>
                  </th>
                  <th className="h-[38px] border-b border-divider px-3.5 font-medium">Time</th>
                  <th className="h-[38px] border-b border-divider px-3.5 font-medium">Who</th>
                  <th className="h-[38px] border-b border-divider px-3.5 font-medium">What happened</th>
                  <th className="h-[38px] border-b border-divider px-3.5 font-medium">Record</th>
                  <th className="h-[38px] border-b border-divider px-3.5 font-medium">From</th>
                </tr>
              </thead>
              <tbody>
                {d.rows.map((r) => {
                  const isOpen = open.has(r.id)
                  return (
                    <React.Fragment key={r.id}>
                      <tr
                        onClick={() => toggle(r.id)}
                        className={cn("cursor-pointer hover:bg-hover", isOpen && "bg-hover")}
                      >
                        <td className="border-b border-divider px-3.5 py-2.5">
                          <span className="flex items-center gap-1">
                            <button
                              type="button"
                              aria-expanded={isOpen}
                              aria-label={isOpen ? "Hide details" : "Show details"}
                              onClick={(e) => {
                                e.stopPropagation()
                                toggle(r.id)
                              }}
                              className="inline-flex size-5 items-center justify-center rounded text-muted-foreground hover:bg-border"
                            >
                              {isOpen ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
                            </button>
                            {r.flag && (
                              <span
                                title="Failed submission"
                                className="inline-flex size-5 items-center justify-center rounded bg-st-red-bg text-[12px] font-bold text-st-red"
                              >
                                !<span className="sr-only">Failed submission</span>
                              </span>
                            )}
                          </span>
                        </td>
                        <td className="border-b border-divider px-3.5 py-2.5 font-mono text-[12px] whitespace-nowrap text-muted-foreground">
                          {when !== "today" && <span className="mr-1.5 font-sans">{fmtDate(r.date)}</span>}
                          {r.time}
                        </td>
                        <td className="border-b border-divider px-3.5 py-2.5 whitespace-nowrap">{r.who}</td>
                        <td className="border-b border-divider px-3.5 py-2.5">{r.what}</td>
                        <td className="border-b border-divider px-3.5 py-2.5 whitespace-nowrap">
                          {isRef(r.record) ? <span className="mono-id">{r.record}</span> : r.record}
                        </td>
                        <td className="border-b border-divider px-3.5 py-2.5 whitespace-nowrap text-ink2">{r.from}</td>
                      </tr>
                      {isOpen && (
                        <tr className="bg-sidebar">
                          <td colSpan={6} className="border-b border-divider px-3.5 py-3.5 pl-[54px]">
                            <Details row={r} />
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  )
                })}
              </tbody>
            </table>
            {d.total > d.page_size && (
              <Pagination
                page={d.page}
                pageSize={d.page_size}
                total={d.total}
                noun="events"
                onPage={(p) => set({ page: p === 1 ? undefined : String(p) })}
              />
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function Details({ row }: { row: Row }) {
  return (
    <div className="grid grid-cols-[130px_minmax(0,1fr)_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-[13px]">
      {row.changes.length > 0 && (
        <>
          <span className="text-muted-foreground">Field</span>
          <span className="text-muted-foreground">Before</span>
          <span className="text-muted-foreground">After</span>
          {row.changes.map((c) => (
            <React.Fragment key={c.field}>
              <span className="capitalize">{c.field.replace(/_/g, " ")}</span>
              <span>
                <span className="inline rounded bg-st-red-bg px-1.5 py-0.5 break-words text-st-red line-through">
                  {fmtValue(c.before)}
                </span>
              </span>
              <span>
                <span className="inline rounded bg-st-green-bg px-1.5 py-0.5 break-words text-st-green">
                  {fmtValue(c.after)}
                </span>
              </span>
            </React.Fragment>
          ))}
        </>
      )}
      {row.changes.length === 0 && (
        <>
          <span className="text-muted-foreground">Changes</span>
          <span className="col-span-2 text-muted-foreground">No field changes recorded for this event.</span>
        </>
      )}
      <span className="text-muted-foreground">Fingerprint</span>
      <span
        className="col-span-2 font-mono text-[12px] text-ink2"
        title={`prev ${row.prev_hash ?? "none"}\nthis ${row.hash}`}
      >
        prev {short(row.prev_hash)} → this {short(row.hash)}
      </span>
    </div>
  )
}

function ChainChip({
  chain,
  loading,
  checking,
  onCheck,
}: {
  chain: AuditData["chain"] | undefined
  loading: boolean
  checking: boolean
  onCheck: () => void
}) {
  if (loading) return null
  if (checking)
    return (
      <span className="inline-flex h-[26px] items-center rounded-full bg-st-grey-bg px-2.5 text-[12.5px] font-medium text-st-grey">
        Checking the chain…
      </span>
    )
  if (!chain)
    return (
      <span className="inline-flex h-[26px] items-center gap-1.5 rounded-full bg-st-grey-bg px-2.5 text-[12.5px] font-medium text-st-grey">
        Not checked yet ·
        <button type="button" onClick={onCheck} className="font-medium text-link hover:underline">
          Check now
        </button>
      </span>
    )
  const today = new Date(chain.checked_at).toDateString() === new Date().toDateString()
  const when = `${today ? "today" : fmtDate(chain.checked_at)} ${fmtTime(chain.checked_at)}`
  return (
    <button
      type="button"
      onClick={onCheck}
      title="Check the chain again now"
      className={cn(
        "inline-flex h-[26px] items-center gap-1.5 rounded-full px-2.5 text-[12.5px] font-medium hover:opacity-85",
        chain.intact ? "bg-st-green-bg text-st-green" : "bg-st-red-bg text-st-red",
      )}
    >
      {chain.intact ? <Check aria-hidden className="size-3.5" /> : <ShieldAlert aria-hidden className="size-3.5" />}
      Chain checked {when} · {chain.intact ? "intact" : "broken"}
    </button>
  )
}

function WhenButton({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [open, setOpen] = React.useState(false)
  const label = WHEN.find((w) => w.value === value)?.label ?? "Today"
  return (
    <PopoverPrimitive.Root open={open} onOpenChange={setOpen}>
      <PopoverPrimitive.Trigger asChild>
        <button
          type="button"
          aria-haspopup="listbox"
          aria-expanded={open}
          className="inline-flex h-8 items-center gap-1.5 rounded-md border border-st-blue bg-st-blue-bg px-2.5 text-[13px] whitespace-nowrap text-st-blue"
        >
          <span>When</span>
          <span className="font-medium">{label}</span>
          <ChevronDown aria-hidden className="size-3.5 opacity-70" />
        </button>
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          align="start"
          sideOffset={6}
          className="z-50 w-48 rounded-lg border border-border bg-popover p-1.5 shadow-lg"
        >
          <div role="listbox" aria-label="When">
            {WHEN.map((w) => (
              <button
                key={w.value}
                type="button"
                role="option"
                aria-selected={w.value === value}
                onClick={() => {
                  onChange(w.value)
                  setOpen(false)
                }}
                className="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-[13px] hover:bg-hover"
              >
                {w.label}
                {w.value === value && <Check aria-hidden className="size-4" />}
              </button>
            ))}
          </div>
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  )
}
