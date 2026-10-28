import { useQuery } from "@tanstack/react-query"
import { Link, useNavigate } from "@tanstack/react-router"
import * as React from "react"

import { api, type ApiError } from "@bide-comply/api-client"
import { DataTable, type ColumnDef } from "@bide-comply/ui/components/data-table"
import { QuickViews, SearchBox, Segmented, Summary } from "@bide-comply/ui/components/filter-bar"
import { EmptyState, ErrorState, LoadingRows, PageHeader, Skeleton } from "@bide-comply/ui/components/page"
import { ScoreRing } from "@bide-comply/ui/components/status"
import { Button } from "@bide-comply/ui/components/button"

import { PropertyCard, placeLine, StatusFor, type PropertyRow } from "../features/overview/properties-card"
import { useParams } from "../lib/params"
import { useMe } from "../lib/session"

type Res = { rows: PropertyRow[]; views: { key: string; label: string; count: number }[] }

const VIEW_STAGE: Record<string, string> = { trading: "trading", opening: "pre_opening", setup: "setup" }
const VIEW_NOUN: Record<string, string> = {
  all: "",
  trading: "trading ",
  opening: "opening-soon ",
  setup: "not-set-up ",
}


export function PropertiesPage() {
  const [params, set] = useParams()
  const me = useMe()
  const navigate = useNavigate()
  const view = params.view ?? "all"
  const q = params.q ?? ""
  const layout = params.layout === "table" ? "table" : "cards"
  const res = useQuery<Res, ApiError>({ queryKey: ["properties"], queryFn: () => api.get<Res>("/api/properties") })

  const rows = React.useMemo(() => {
    const all = res.data?.rows ?? []
    const term = q.trim().toLowerCase()
    return all.filter(
      (r) =>
        (view === "all" || r.stage === VIEW_STAGE[view]) &&
        (!term || `${r.name} ${r.code} ${r.town ?? ""} ${r.dutyholder ?? ""}`.toLowerCase().includes(term)),
    )
  }, [res.data, view, q])

  const columns = React.useMemo<ColumnDef<PropertyRow, unknown>[]>(
    () => [
      {
        id: "name",
        header: "Property",
        cell: ({ row: { original: p } }) => (
          <span className="flex items-center gap-3">
            <ScoreRing score={p.score} status={p.score == null ? "grey" : p.score_status} redLine={p.red_line} size={36} />
            <span>
              <span className="font-medium">{p.name}</span> <span className="mono-id text-muted-foreground">{p.code}</span>
              <span className="block text-[12.5px] text-muted-foreground">{placeLine(p)}</span>
            </span>
          </span>
        ),
      },
      { id: "stage", header: "Stage", cell: ({ row }) => row.original.stage_label },
      { id: "status", header: "Status", cell: ({ row }) => <StatusFor p={row.original} /> },
      {
        id: "a_late",
        header: "Life-safety overdue",
        meta: { align: "right" },
        cell: ({ row }) => (row.original.register_loaded ? row.original.class_a_late : "—"),
      },
      { id: "urgent", header: "Urgent actions", meta: { align: "right" }, cell: ({ row }) => row.original.actions.urgent },
      {
        id: "gate",
        header: "Gate A open",
        meta: { align: "right" },
        cell: ({ row }) => row.original.gate?.class_a_open ?? "—",
      },
      {
        id: "note",
        header: "Note",
        cell: ({ row }) => <span className="text-[12.5px] text-muted-foreground">{row.original.note}</span>,
      },
    ],
    [],
  )

  const viewLabel = VIEW_NOUN[view] ?? ""
  const summary =
    rows.length === 0
      ? "No properties match."
      : `Showing ${view === "all" && !q ? "all " : ""}${rows.length} ${viewLabel}${rows.length === 1 ? "property" : "properties"}${
          q ? ` matching “${q}”` : ""
        }. Worst first.`

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Properties"
        subtitle="Pick a property to see its checks, fixes and certificates."
        actions={
          me.data?.can["settings.view"] ? (
            <Button asChild>
              <Link to="/settings/setup">Add a property</Link>
            </Button>
          ) : null
        }
        className="items-end"
      />
      <div className="flex flex-wrap items-center gap-2">
        {res.data ? (
          <QuickViews
            views={res.data.views.map((v) => ({ ...v, on: v.key === view }))}
            onPick={(k) => set({ view: k === "all" ? undefined : k })}
          />
        ) : (
          <Skeleton className="h-8 w-96" />
        )}
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <SearchBox
            value={q}
            onChange={(v) => set({ q: v || undefined })}
            placeholder="Search properties or towns"
            count={q ? rows.length : null}
          />
          <Segmented
            label="Layout"
            value={layout}
            onChange={(v) => set({ layout: v === "cards" ? undefined : v })}
            options={[
              { value: "cards", label: "Cards" },
              { value: "table", label: "Table" },
            ]}
          />
        </div>
      </div>
      {res.data && <Summary className="-mt-1 text-ink2">{summary}</Summary>}

      {res.isError ? (
        <ErrorState message={res.error.message} onRetry={() => void res.refetch()} />
      ) : res.isLoading ? (
        layout === "cards" ? (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(320px,1fr))] gap-4">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-[190px] rounded-xl" />
            ))}
          </div>
        ) : (
          <LoadingRows />
        )
      ) : rows.length === 0 ? (
        <div className="rounded-xl border border-divider bg-surface">
          <EmptyState
            title={q ? `No properties match “${q}”` : "No properties in this view"}
            action={
              <Button variant="secondary" onClick={() => set({ q: undefined, view: undefined })}>
                Show all properties
              </Button>
            }
          >
            {q ? "Check the spelling, or search by town or code." : "Try another quick view."}
          </EmptyState>
        </div>
      ) : layout === "cards" ? (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(320px,1fr))] gap-4">
          {rows.map((p) => (
            <PropertyCard key={p.id} p={p} />
          ))}
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-divider bg-surface">
          <DataTable
            columns={columns}
            rows={rows}
            caption="Properties, worst first"
            onRowClick={(p) => {
              const params = { code: p.code }
              if (p.stage === "setup") void navigate({ to: "/settings/setup/$code", params })
              else if (p.stage === "pre_opening") void navigate({ to: "/gates/$code", params })
              else void navigate({ to: "/properties/$code", params })
            }}
            mobileCard={(p) => <PropertyCard p={p} />}
          />
        </div>
      )}
      <p className="m-0 text-[12.5px] text-muted-foreground">
        The ring is the compliance score. It turns red whenever any life-safety item is overdue, whatever the percentage.
      </p>
    </div>
  )
}
