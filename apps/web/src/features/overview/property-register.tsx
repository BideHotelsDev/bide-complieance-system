/* The Register tab of One property: quick views, filters, the sentence, and the table grouped by area. */
import { keepPreviousData, useQuery } from "@tanstack/react-query"
import * as React from "react"

import { api, ApiError, download } from "@bide-comply/api-client"
import { DataTable, type ColumnDef } from "@bide-comply/ui/components/data-table"
import { FilterBar, QuickViews, SearchBox, Summary } from "@bide-comply/ui/components/filter-bar"
import { Card, EmptyState, ErrorState, LoadingRows } from "@bide-comply/ui/components/page"
import { ClassBadge } from "@bide-comply/ui/components/status"
import { toastError } from "@bide-comply/ui/components/toaster"
import { cn } from "@bide-comply/ui/lib/utils"

import { useParams } from "@/lib/params"
import { RegisterSheet, StatusPill } from "./property-sheet"
import type { PropertyDetail, RegisterList, RegisterRow } from "./property-types"

type Col = {
  id: string
  header: string
  cell: (ctx: { row: { original: RegisterRow } }) => React.ReactNode
  meta?: { sortable?: boolean }
}

const FACET_PARAMS = ["status", "area", "doneby", "class"] as const

const btn =
  "inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-surface px-2.5 text-[13px] whitespace-nowrap text-foreground hover:bg-hover"

export function RegisterTab({ property }: { property: PropertyDetail }) {
  const [p, set] = useParams()
  const group = p.group ?? "area"
  const sort = p.sort ?? "next_due"
  const query = {
    view: p.view ?? "attention",
    q: p.q,
    status: p.status,
    area: p.area,
    doneby: p.doneby,
    class: p.class,
    group,
    sort,
  }
  const q = useQuery<RegisterList, ApiError>({
    queryKey: ["property", property.code, "register", query],
    queryFn: () => api.get<RegisterList>(`/api/properties/${property.code}/register`, query),
    placeholderData: keepPreviousData,
  })
  const d = q.data
  const selectedRef = p.item ?? null
  const selectedId = d?.rows.find((r) => r.ref === selectedRef)?.id ?? null

  const columns = React.useMemo<ColumnDef<RegisterRow, unknown>[]>(
    () =>
      (
        [
          {
            id: "ref",
            header: "ID",
            cell: ({ row }) => <span className="mono-id whitespace-nowrap">{row.original.ref}</span>,
            meta: { sortable: true },
          },
          {
            id: "check",
            header: "Check",
            cell: ({ row }) => (
              <span
                className="block max-w-[200px] truncate xl:max-w-[240px] 2xl:max-w-[420px]"
                title={row.original.check}
              >
                {row.original.check}
              </span>
            ),
          },
          {
            id: "status",
            header: "Status",
            cell: ({ row }) => <StatusPill status={row.original.status} label={row.original.status_label} />,
            meta: { sortable: true },
          },
          {
            id: "next_due",
            header: "Next due",
            // Not-applicable rows give their reason here, which can be long.
            cell: ({ row }) => (
              <span className="block max-w-[130px] truncate 2xl:max-w-[220px]" title={row.original.next_due_label}>
                {row.original.next_due_label}
              </span>
            ),
            meta: { sortable: true },
          },
          {
            id: "done_by",
            header: "Done by",
            cell: ({ row }) =>
              row.original.done_by === "Needs a name" ? (
                <span className="text-st-amber">Needs a name</span>
              ) : (
                <span className="block max-w-[150px] truncate 2xl:max-w-[240px]" title={row.original.done_by}>
                  {row.original.done_by}
                </span>
              ),
          },
          {
            id: "freq",
            header: "How often",
            cell: ({ row }) => (
              <span className="block max-w-[130px] truncate 2xl:max-w-[200px]" title={row.original.frequency_label}>
                {row.original.frequency_label}
              </span>
            ),
          },
          {
            id: "class",
            header: "Class",
            cell: ({ row }) => (
              <ClassBadge klass={row.original.class} className={cn(row.original.status === "grey" && "opacity-50")} />
            ),
          },
          {
            id: "last",
            header: "Last done",
            cell: ({ row }) => (
              <span className={cn("whitespace-nowrap", !row.original.last_done_on && "text-muted-foreground")}>
                {row.original.last_done_label}
              </span>
            ),
          },
        ] as Col[]
      ).map((c) => ({
        ...c,
        // Grey (not applicable) rows read quieter, as in the design.
        cell: (ctx) => {
          const inner = c.cell(ctx)
          return ctx.row.original.status === "grey" ? <span className="text-subtle">{inner}</span> : inner
        },
      })),
    [],
  )
  const groups =
    group === "area" && d
      ? d.groups.map((g) => {
          const red = g.rows.filter((r) => r.status === "red").length
          return {
            key: g.key,
            label: `${g.name} · ${g.rows.length} item${g.rows.length === 1 ? "" : "s"}${red ? ` · ${red} Red` : ""}`,
            ids: g.rows.map((r) => r.id),
          }
        })
      : undefined

  const exportRows = async () => {
    if (!d) return
    try {
      await download(
        "/api/export",
        {
          name: `Register ${property.code}`,
          columns: [
            { key: "ref", label: "ID" },
            { key: "check", label: "Check" },
            { key: "domain", label: "Area" },
            { key: "status_label", label: "Status" },
            { key: "next_due_label", label: "Next due" },
            { key: "done_by", label: "Done by" },
            { key: "accountable", label: "Accountable" },
            { key: "frequency_label", label: "How often" },
            { key: "class", label: "Class" },
            { key: "last_done_label", label: "Last done" },
          ],
          rows: d.rows,
          format: "csv",
        },
        `Register ${property.code}.csv`,
      )
    } catch (e) {
      toastError(e instanceof ApiError ? e.message : "The export didn't finish. Try again.")
    }
  }

  const sortLabel =
    { next_due: "sorted by next due", ref: "sorted by ID", status: "worst first" }[sort] ?? "sorted by next due"

  return (
    <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
      <div className="flex min-w-0 flex-1 flex-col gap-3">
        {d && <QuickViews views={d.views} onPick={(k) => set({ view: k === "attention" ? undefined : k })} />}
        <FilterBar
          facets={d?.facets ?? []}
          onFacet={(k, v) => set({ [k]: v.join(",") || undefined })}
          anyFilter={FACET_PARAMS.some((k) => p[k]) || !!p.q}
          onClearAll={() =>
            set({ status: undefined, area: undefined, doneby: undefined, class: undefined, q: undefined })
          }
          search={
            <SearchBox
              value={p.q ?? ""}
              onChange={(v) => set({ q: v || undefined })}
              placeholder="Search checks, rooms or people"
              count={p.q ? d?.total : null}
              className="w-[280px]"
            />
          }
        >
          <button
            type="button"
            className={btn}
            aria-pressed={group === "area"}
            onClick={() => set({ group: group === "area" ? "none" : undefined })}
          >
            <span className="text-muted-foreground">Group by</span>
            <span className="font-medium">{group === "area" ? "Area" : "None"}</span>
          </button>
          <button type="button" className={btn} onClick={() => void exportRows()} disabled={!d}>
            Export
          </button>
        </FilterBar>
        {d && <Summary className="text-ink2">{d.summary}</Summary>}
        <Card className="overflow-hidden">
          {q.isPending ? (
            <LoadingRows rows={8} label="Loading the register" />
          ) : q.error ? (
            <ErrorState message={q.error.message} onRetry={() => void q.refetch()} />
          ) : d && d.of_total === 0 ? (
            <EmptyState title="The register isn't loaded yet">
              {property.stage === "setup"
                ? "Finish setting up this property to load its checks."
                : "Load the checks for this property from Settings › Set up a property."}
            </EmptyState>
          ) : (
            d && (
              <>
                <DataTable
                  columns={columns}
                  rows={d.rows}
                  groups={groups}
                  selectedId={selectedId}
                  onRowClick={(r) => set({ item: r.ref === selectedRef ? undefined : r.ref })}
                  sort={{ id: sort, desc: false }}
                  onSort={(s) => set({ sort: s && s.id !== "next_due" ? s.id : undefined })}
                  density="compact"
                  caption={`Register at ${property.name}`}
                  empty={
                    <EmptyState
                      title={d.nothing_overdue && !d.any_filter ? d.nothing_overdue : "No checks match these filters"}
                    >
                      <button
                        type="button"
                        className="text-link"
                        onClick={() =>
                          set({
                            view: "all",
                            status: undefined,
                            area: undefined,
                            doneby: undefined,
                            class: undefined,
                            q: undefined,
                          })
                        }
                      >
                        Show everything
                      </button>
                    </EmptyState>
                  }
                  mobileCard={(r) => (
                    <div className="flex flex-col gap-1">
                      <div className="flex items-center gap-2">
                        <span className="mono-id text-muted-foreground">{r.ref}</span>
                        <ClassBadge klass={r.class} />
                        <StatusPill status={r.status} label={r.status_label} />
                      </div>
                      <div className="font-medium">{r.check}</div>
                      <div className="text-xs text-muted-foreground">
                        {r.next_due_label} · {r.done_by} · {r.frequency_label}
                      </div>
                    </div>
                  )}
                />
                <div className="flex items-center gap-3 border-t border-divider px-3 py-2 text-xs text-muted-foreground">
                  <span>
                    {d.total} of {d.of_total} items match the filters
                  </span>
                  <span className="ml-auto">
                    {group === "area" ? "Grouped by area · " : ""}
                    {sortLabel}
                  </span>
                </div>
              </>
            )
          )}
        </Card>
      </div>
      {selectedRef && <RegisterSheet key={selectedRef} refId={selectedRef} onClose={() => set({ item: undefined })} />}
    </div>
  )
}
