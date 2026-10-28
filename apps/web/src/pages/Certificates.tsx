import { keepPreviousData, useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import * as React from "react"

import { api, type ApiError } from "@bide-comply/api-client"
import { Button } from "@bide-comply/ui/components/button"
import { DataTable, Pagination, type ColumnDef } from "@bide-comply/ui/components/data-table"
import { FilterBar, QuickViews, SearchBox, Summary, type Facet, type QuickView } from "@bide-comply/ui/components/filter-bar"
import { Breadcrumb, EmptyState, ErrorState, LoadingRows, PageHeader, Skeleton } from "@bide-comply/ui/components/page"
import { Pill, type Tone } from "@bide-comply/ui/components/status"

import { CertificateTimeline } from "../features/overview/certificates-timeline"
import { isRequired, UploadCertificateDialog, type CertRow } from "../features/overview/certificates-upload"
import { fmtDate, fmtDay } from "../lib/format"
import { useParams } from "../lib/params"
import { useProperty } from "../lib/property"
import { useMe } from "../lib/session"

type Timeline = {
  today: string
  start: string
  end: string
  window_days: number
  months: { date: string; label: string }[]
  marks: { id: string; date: string; title: string; property: string | null; status: string }[]
}
type Res = {
  rows: CertRow[]
  total: number
  page: number
  page_size: number
  views: QuickView[]
  facets: Facet[]
  summary: string
  any_filter: boolean
  timeline: Timeline
}

const TONE: Record<CertRow["status"], Tone> = {
  missing: "red",
  due: "red",
  fails: "red",
  expired: "red",
  partial: "amber",
  expiring: "amber",
  valid: "green",
}

export function CertificatesPage() {
  const [params, set] = useParams()
  const { propertyId } = useProperty()
  const me = useMe()
  const canFile = !!me.data?.can.assign
  const view = params.view ?? "all"
  const page = Number(params.page ?? 1)
  const pageSize = Number(params.size ?? 25)
  const query = {
    view,
    q: params.q,
    prop: params.prop,
    kind: params.kind,
    property: propertyId,
    page,
    page_size: pageSize,
  }
  const res = useQuery<Res, ApiError>({
    queryKey: ["certificates", query],
    queryFn: () => api.get<Res>("/api/certificates", query),
    placeholderData: keepPreviousData,
  })
  // Every required certificate, for the header button's picker.
  const required = useQuery<Res, ApiError>({
    queryKey: ["certificates", "required", propertyId],
    queryFn: () => api.get<Res>("/api/certificates", { view: "missing", property: propertyId, page_size: 100 }),
    enabled: canFile,
  })
  const [dialog, setDialog] = React.useState<{ open: boolean; target: CertRow | null }>({ open: false, target: null })

  const columns = React.useMemo<ColumnDef<CertRow, unknown>[]>(
    () => [
      {
        id: "title",
        header: "Certificate",
        cell: ({ row: { original: c } }) => (
          <span>
            <span className="font-medium">{c.title}</span>
            {c.file_name && <span className="block text-xs text-muted-foreground">{c.file_name}</span>}
          </span>
        ),
      },
      { id: "property", header: "Property", cell: ({ row }) => <span className="whitespace-nowrap">{row.original.property ?? "Group"}</span> },
      {
        id: "why",
        header: "Why it is needed",
        cell: ({ row }) => <span className="text-muted-foreground">{row.original.why ?? "—"}</span>,
      },
      { id: "provider", header: "Who provides it", cell: ({ row }) => row.original.provider ?? "—" },
      {
        id: "action",
        header: "Linked action",
        cell: ({ row }) =>
          row.original.action_ref ? (
            <Link
              to="/actions"
              search={{ sel: row.original.action_ref }}
              onClick={(e) => e.stopPropagation()}
              className="mono-id text-muted-foreground hover:text-link"
            >
              {row.original.action_ref}
            </Link>
          ) : (
            <span className="text-subtle">—</span>
          ),
      },
      {
        id: "status",
        header: "Status",
        cell: ({ row: { original: c } }) => (
          <span className="flex flex-col items-start gap-0.5">
            <Pill tone={TONE[c.status]}>{c.status_label}</Pill>
            {!isRequired(c) && c.expires_on && (
              <span className="tabular text-xs whitespace-nowrap text-muted-foreground">until {fmtDate(c.expires_on, true)}</span>
            )}
          </span>
        ),
      },
      {
        id: "upload",
        header: () => <span className="sr-only">Upload</span>,
        meta: { align: "right" },
        cell: ({ row: { original: c } }) =>
          canFile && c.property_id ? (
            <Button
              variant="secondary"
              onClick={(e) => {
                e.stopPropagation()
                setDialog({ open: true, target: c })
              }}
              aria-label={`${isRequired(c) ? "Upload" : "Upload new"}: ${c.title}`}
            >
              {isRequired(c) ? "Upload" : "Upload new"}
            </Button>
          ) : null,
      },
    ],
    [canFile],
  )

  const d = res.data
  const tl = d?.timeline
  const marksLabel =
    tl && tl.marks.length
      ? tl.marks
          .map((m) => `${m.title}${m.property ? ` at ${m.property}` : ""} ${fmtDate(m.date, true)}`)
          .join("; ")
      : "No certificates expire in the next 12 months"

  return (
    <div className="flex flex-col gap-4">
      <Breadcrumb items={[{ label: "Properties", href: "/properties" }, { label: "Certificates" }]} />
      <PageHeader
        className="-mt-2 items-end"
        title="Certificates"
        subtitle="Every certificate with an expiry date. Reminders go out 60, 30 and 14 days before."
        actions={
          canFile ? <Button onClick={() => setDialog({ open: true, target: null })}>Upload a certificate</Button> : null
        }
      />

      <section aria-labelledby="tlh" className="rounded-xl border border-divider bg-surface px-[18px] py-4">
        <div className="flex items-baseline justify-between gap-3">
          <h2 id="tlh" className="m-0 text-[15px] font-semibold">
            Expiry timeline · next 12 months
          </h2>
          {tl && (
            <span className="text-[12.5px] text-muted-foreground">
              Today: {fmtDay(tl.today)} {tl.today.slice(0, 4)}
            </span>
          )}
        </div>
        {tl ? (
          <div className="mt-3">
            <CertificateTimeline
              start={tl.start}
              end={tl.end}
              months={tl.months}
              marks={tl.marks}
              windowDays={tl.window_days}
              label={marksLabel}
            />
            {tl.marks.length === 0 && (
              <p className="m-0 text-[13px] text-muted-foreground">Nothing expires in the next 12 months.</p>
            )}
          </div>
        ) : res.isError ? null : (
          <Skeleton className="mt-3 h-[120px]" />
        )}
      </section>

      {d ? (
        <QuickViews views={d.views} onPick={(k) => set({ view: k === "all" ? undefined : k, page: undefined })} />
      ) : (
        <Skeleton className="h-8 w-[560px] max-w-full" />
      )}
      <FilterBar
        search={
          <SearchBox
            value={params.q ?? ""}
            onChange={(v) => set({ q: v || undefined, page: undefined })}
            placeholder="Search certificates or issuers"
            count={params.q ? d?.total : null}
          />
        }
        facets={d?.facets ?? []}
        onFacet={(k, v) => set({ [k]: v.join(",") || undefined, page: undefined })}
        anyFilter={!!(params.q || params.prop || params.kind)}
        onClearAll={() => set({ q: undefined, prop: undefined, kind: undefined, page: undefined })}
      />
      {d && <Summary className="-mt-1 text-ink2">{d.summary}</Summary>}

      <div className="overflow-hidden rounded-xl border border-divider bg-surface">
        {res.isError ? (
          <ErrorState message={res.error.message} onRetry={() => void res.refetch()} />
        ) : !d ? (
          <LoadingRows />
        ) : d.rows.length === 0 ? (
          <EmptyState
            title={d.any_filter ? "No certificates match" : "No certificates yet"}
            action={
              d.any_filter ? (
                <Button
                  variant="secondary"
                  onClick={() => set({ view: undefined, q: undefined, prop: undefined, kind: undefined, page: undefined })}
                >
                  Show all certificates
                </Button>
              ) : canFile ? (
                <Button onClick={() => setDialog({ open: true, target: null })}>Upload a certificate</Button>
              ) : null
            }
          >
            {d.any_filter
              ? view === "expired"
                ? "Nothing has expired. Certificates show here the day after they run out."
                : "Try another quick view or clear the filters."
              : "Certificates appear here when they're uploaded or when a register item needs one."}
          </EmptyState>
        ) : (
          <>
            <DataTable
              columns={columns}
              rows={d.rows}
              caption="Certificates"
              onRowClick={canFile ? (c) => { if (c.property_id) setDialog({ open: true, target: c }) } : undefined}
              mobileCard={(c) => (
                <div className="flex flex-col gap-1.5">
                  <div className="font-medium">{c.title}</div>
                  <div className="text-[12.5px] text-muted-foreground">
                    {[c.property, c.why, c.provider].filter(Boolean).join(" · ")}
                  </div>
                  <div className="flex items-center gap-2">
                    <Pill tone={TONE[c.status]}>{c.status_label}</Pill>
                    {c.action_ref && <span className="mono-id text-muted-foreground">{c.action_ref}</span>}
                    {canFile && c.property_id && (
                      <span className="ml-auto text-[12.5px] font-medium text-link">
                        {isRequired(c) ? "Upload" : "Upload new"}
                      </span>
                    )}
                  </div>
                </div>
              )}
            />
            <div className="flex flex-wrap items-center gap-3 border-t border-divider text-[12.5px] text-muted-foreground">
              {d.total > d.page_size ? (
                <div className="flex-1">
                  <Pagination
                    page={d.page}
                    pageSize={d.page_size}
                    total={d.total}
                    noun="certificates"
                    onPage={(p) => set({ page: p > 1 ? String(p) : undefined })}
                    onPageSize={(n) => set({ size: n === 25 ? undefined : String(n), page: undefined })}
                  />
                </div>
              ) : (
                <span className="tabular px-3.5 py-2.5">
                  {d.rows.length} of {d.total} shown
                </span>
              )}
              <span className="ml-auto px-3.5 py-2.5">
                Uploading a certificate closes its linked action only if it has no fails
              </span>
            </div>
          </>
        )}
      </div>

      <UploadCertificateDialog
        open={dialog.open}
        onOpenChange={(open) => setDialog((s) => ({ ...s, open }))}
        target={dialog.target}
        required={required.data?.rows ?? []}
        defaultPropertyId={propertyId}
      />
    </div>
  )
}
