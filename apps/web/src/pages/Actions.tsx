/*
 * Actions to fix (design: Actions.dc.html): everything that needs fixing, who owns it and when it's due. Quick views,
 * search and facets live in the URL; the selected row opens beside the list (?sel=<ref>); Board view groups the same
 * filtered rows into Urgent / Soon / Later.
 */
import { keepPreviousData, useQuery } from "@tanstack/react-query"
import * as React from "react"
import { AlertTriangle, Check, ChevronDown, ListChecks } from "lucide-react"
import { DropdownMenu as Menu } from "radix-ui"

import { api, type ApiError } from "@bide-comply/api-client"
import { Button } from "@bide-comply/ui/components/button"
import { DataTable, Pagination, type ColumnDef } from "@bide-comply/ui/components/data-table"
import { FilterBar, QuickViews, SearchBox, Summary } from "@bide-comply/ui/components/filter-bar"
import { EmptyState, ErrorState, LoadingRows, PageHeader, Skeleton } from "@bide-comply/ui/components/page"
import { Pill, PriorityBadge, type Priority } from "@bide-comply/ui/components/status"
import { cn } from "@bide-comply/ui/lib/utils"

import { ActionPanel } from "@/features/queues/action-panel"
import { NewActionDialog } from "@/features/queues/new-action"
import type { ActionList, ActionRow } from "@/features/queues/types"
import { BarRow, IconBox, Legend, Ring, StatBig, StatCard, StatTitle } from "@/features/queues/ui"
import { fmtDate } from "@/lib/format"
import { useParams } from "@/lib/params"
import { useProperty } from "@/lib/property"
import { useMe } from "@/lib/session"

const SORTS = [
  { key: "due", label: "Due date, soonest first" },
  { key: "priority", label: "Priority, most urgent first" },
  { key: "raised", label: "Raised, newest first" },
  { key: "ref", label: "ID" },
] as const

const FACET_KEYS = ["prop", "type", "prio", "source", "gate"] as const
const PRIO_COLOR: Record<Priority, string> = {
  high: "var(--c-foreground)",
  med: "var(--c-subtle)",
  low: "var(--c-border)",
}

export function ActionsPage() {
  const [params, set] = useParams()
  const me = useMe()
  const { propertyId } = useProperty()
  const [creating, setCreating] = React.useState(false)
  const board = params.board === "1"
  const sort = params.sort ?? "due"
  const page = Number(params.page ?? 1)
  const sel = params.sel ?? null

  const query = {
    q: params.q,
    view: params.view ?? "all",
    prop: params.prop,
    type: params.type,
    prio: params.prio,
    source: params.source,
    gate: params.gate,
    owner: params.owner,
    sort,
    page: board ? 1 : page,
    page_size: board ? 200 : 25,
    property: propertyId ?? undefined,
  }
  const res = useQuery<ActionList, ApiError>({
    queryKey: ["actions", query],
    queryFn: () => api.get<ActionList>("/api/actions", query),
    placeholderData: keepPreviousData,
  })
  const d = res.data

  const pick = (ref: string | null) => set({ sel: ref ?? undefined })
  const clearAll = () =>
    set({
      owner: undefined,
      q: undefined,
      view: undefined,
      prop: undefined,
      type: undefined,
      prio: undefined,
      source: undefined,
      gate: undefined,
      page: undefined,
    })

  const selectedId = d?.rows.find((r) => r.ref === sel)?.id ?? null

  const columns = React.useMemo<ColumnDef<ActionRow, unknown>[]>(
    () => [
      {
        id: "ref",
        header: "ID",
        meta: { sortable: true, className: "whitespace-nowrap" },
        cell: ({ row: { original: r } }) => <span className="mono-id">{r.ref}</span>,
      },
      {
        id: "description",
        header: "Description",
        cell: ({ row: { original: r } }) => (
          <div className="min-w-0">
            <div className="max-w-[230px] truncate min-[1400px]:max-w-[320px] 2xl:max-w-[440px]" title={r.description}>
              {r.description}
            </div>
            <div className="max-w-[230px] truncate text-[12px] text-muted-foreground min-[1400px]:max-w-[320px] 2xl:max-w-[440px]">
              {[r.property, r.source_label, r.gate_ref ? `Gate ${r.gate_ref}` : null].filter(Boolean).join(" · ")}
            </div>
          </div>
        ),
      },
      {
        id: "priority",
        header: "Priority",
        meta: { sortable: true },
        cell: ({ row: { original: r } }) => <PriorityBadge priority={r.priority} />,
      },
      {
        id: "due",
        header: "Due",
        meta: { sortable: true, className: "whitespace-nowrap" },
        cell: ({ row: { original: r } }) => (
          <>
            <span className="tabular">{fmtDate(r.due_on)}</span>
            <div className={cn("text-[12px]", r.late ? "font-medium text-st-red" : "text-muted-foreground")}>
              {r.left}
            </div>
          </>
        ),
      },
      {
        id: "status",
        header: "Status",
        cell: ({ row: { original: r } }) => <StatusPill r={r} />,
      },
      {
        id: "owner",
        header: "Owner",
        meta: { className: "whitespace-nowrap" },
        cell: ({ row: { original: r } }) => r.owner ?? <span className="text-st-amber">Nobody yet</span>,
      },
      {
        id: "type",
        header: "Type",
        meta: { className: "whitespace-nowrap" },
        cell: ({ row: { original: r } }) => r.type_label,
      },
    ],
    [],
  )

  const sortLabel = SORTS.find((s) => s.key === sort)?.label ?? SORTS[0].label
  // The table header arrows map onto the server's sort keys (each has one natural direction).
  const tableSort = sort === "raised" ? null : { id: sort, desc: false }

  return (
    <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
      <div className="flex min-w-0 flex-1 flex-col gap-3.5">
        <PageHeader
          title="Actions to fix"
          subtitle="Everything that needs fixing, who owns it, and when it's due."
          actions={
            <>
              <Button
                variant="outline"
                aria-pressed={board}
                onClick={() => set({ board: board ? undefined : "1", page: undefined })}
              >
                {board ? "List view" : "Board view"}
              </Button>
              {me.data?.can["action.raise"] && <Button onClick={() => setCreating(true)}>New Action</Button>}
            </>
          }
        />

        <Stats d={d} />

        {d ? (
          <QuickViews views={d.views} onPick={(k) => set({ view: k === "all" ? undefined : k, page: undefined })} />
        ) : (
          <Skeleton className="h-8 w-[520px] max-w-full" />
        )}

        <FilterBar
          facets={(d?.facets ?? []).filter((f) => f.options.length > 0)}
          onFacet={(k, v) => set({ [k]: v.join(",") || undefined, page: undefined })}
          anyFilter={
            FACET_KEYS.some((k) => params[k]) || !!params.q || !!params.owner || (params.view ?? "all") !== "all"
          }
          onClearAll={clearAll}
          search={
            <SearchBox
              value={params.q ?? ""}
              onChange={(v) => set({ q: v || undefined, page: undefined })}
              placeholder="Search by ID, words or person"
              className="w-[300px]"
            />
          }
        >
          {params.owner && (
            <button
              type="button"
              onClick={() => set({ owner: undefined, page: undefined })}
              aria-label={`Remove filter: owner ${d?.owner?.name ?? ""}`}
              className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-foreground/40 bg-surface px-2.5 text-[13px] hover:bg-hover"
            >
              <span className="text-muted-foreground">Owner</span>
              <span className="font-medium">{d?.owner?.name ?? "…"}</span>
              <span aria-hidden className="text-muted-foreground">
                ×
              </span>
            </button>
          )}
          <SortMenu
            value={sort}
            label={sortLabel}
            onChange={(s) => set({ sort: s === "due" ? undefined : s, page: undefined })}
          />
        </FilterBar>

        <Summary className="-mt-1 text-[13.5px] text-ink2">{d ? d.summary : " "}</Summary>

        {res.error && !d ? (
          <div className="rounded-[10px] border border-divider bg-surface">
            <ErrorState
              message={res.error.status === 403 ? "You don't have access to Actions here." : undefined}
              onRetry={() => void res.refetch()}
            />
          </div>
        ) : board ? (
          <Board d={d} sel={sel} onPick={pick} />
        ) : (
          <div className="overflow-hidden rounded-[10px] border border-divider bg-surface">
            {!d ? (
              <LoadingRows rows={8} label="Loading Actions" />
            ) : (
              <DataTable
                columns={columns}
                rows={d.rows}
                caption="Actions to fix"
                selectedId={selectedId}
                onRowClick={(r) => pick(r.ref === sel ? null : r.ref)}
                sort={tableSort}
                onSort={(s) => s && set({ sort: s.id === "due" ? undefined : s.id, page: undefined })}
                empty={<NoRows anyFilter={d.any_filter} summary={d.summary} onClear={clearAll} />}
                mobileCard={(r) => (
                  <div className="flex flex-col gap-1">
                    <div className="flex items-center gap-2">
                      <span className="mono-id">{r.ref}</span>
                      <PriorityBadge priority={r.priority} />
                      <span className={cn("ml-auto text-[12px]", r.late ? "text-st-red" : "text-muted-foreground")}>
                        {fmtDate(r.due_on)} · {r.left}
                      </span>
                    </div>
                    <div className="line-clamp-2 text-[13.5px]">{r.description}</div>
                    <div className="text-[12px] text-muted-foreground">
                      {r.property} · {r.owner ?? "Nobody yet"} · {r.type_label}
                    </div>
                  </div>
                )}
              />
            )}
            {d && d.rows.length > 0 && (
              <div className="flex flex-wrap items-center border-t border-divider">
                <Pagination
                  page={d.page}
                  pageSize={d.page_size}
                  total={d.total}
                  noun={d.total === 1 ? "item" : "items"}
                  onPage={(p) => set({ page: p === 1 ? undefined : String(p) })}
                />
                <span className="px-3 pb-2.5 text-[12px] text-muted-foreground sm:ml-auto sm:pb-0">
                  Close only with evidence · Advisories close with a recorded decision
                </span>
              </div>
            )}
          </div>
        )}
      </div>

      {sel && <ActionPanel key={sel} ref_={sel} onClose={() => pick(null)} onClosed={() => pick(null)} />}

      <NewActionDialog
        open={creating}
        onOpenChange={setCreating}
        defaultPropertyId={propertyId}
        onCreated={(ref) => pick(ref)}
      />
    </div>
  )
}

function StatusPill({ r }: { r: ActionRow }) {
  if (r.status === "closed") return <Pill tone="green">Closed</Pill>
  if (r.awaiting_verification) return <Pill tone="blue">Fix to check</Pill>
  if (r.late) return <Pill tone="solid-amber">Overdue</Pill>
  return <Pill tone={r.status === "to_confirm" ? "amber" : "grey"}>{r.status_label}</Pill>
}

function NoRows({ anyFilter, summary, onClear }: { anyFilter: boolean; summary: string; onClear: () => void }) {
  return anyFilter ? (
    <EmptyState
      title="Nothing matches these filters"
      action={
        <Button variant="outline" onClick={onClear}>
          Clear all filters
        </Button>
      }
    >
      {summary}
    </EmptyState>
  ) : (
    <EmptyState icon={<ListChecks className="size-6" />} title="Nothing to fix">
      Every Action here is closed. New ones appear when a check fails, an assessor finds something, or someone raises
      one.
    </EmptyState>
  )
}

function Stats({ d }: { d: ActionList | undefined }) {
  if (!d)
    return (
      <div className="grid gap-3.5 md:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-[112px] rounded-xl" />
        ))}
      </div>
    )
  const s = d.stats
  const segs = (["high", "med", "low"] as const).map((p) => ({
    label: { high: "Urgent", med: "Soon", low: "Later" }[p],
    title: { high: "Urgent · 7 days", med: "Soon · 30 days", low: "Later · 90 days" }[p],
    value: s.by_urgency[p],
    color: PRIO_COLOR[p],
  }))
  const max = Math.max(1, ...s.by_property.map((p) => p.count))
  return (
    <div className="grid gap-3.5 md:grid-cols-3">
      <StatCard>
        <Ring
          segments={segs}
          center={s.open_total}
          label={`${s.open_total} open: ${segs.map((x) => `${x.value} ${x.label.toLowerCase()}`).join(", ")}`}
        />
        <div className="min-w-0 flex-1">
          <StatTitle>Open by urgency</StatTitle>
          <Legend items={segs} />
        </div>
      </StatCard>
      <StatCard col>
        <StatTitle>Open by property</StatTitle>
        {s.by_property.length === 0 ? (
          <span className="text-[12.5px] text-muted-foreground">Nothing open.</span>
        ) : (
          s.by_property.slice(0, 4).map((p) => <BarRow key={p.property} label={p.property} value={p.count} max={max} />)
        )}
      </StatCard>
      <StatCard>
        <IconBox tone={s.urgent_late ? "red" : "grey"}>
          <AlertTriangle className="size-5" />
        </IconBox>
        <div className="min-w-0 flex-1">
          <StatTitle>Urgent actions running late</StatTitle>
          <StatBig value={s.urgent_late} sub={`of ${s.urgent_total} urgent`} />
          <div className="mt-2 flex flex-wrap gap-[3px]" aria-hidden>
            {Array.from({ length: Math.min(s.urgent_total, 40) }).map((_, i) => (
              <span
                key={i}
                className={cn("size-[9px] rounded-full", i < s.urgent_late ? "bg-foreground" : "bg-border")}
              />
            ))}
          </div>
        </div>
      </StatCard>
    </div>
  )
}

function SortMenu({ value, label, onChange }: { value: string; label: string; onChange: (k: string) => void }) {
  return (
    <Menu.Root>
      <Menu.Trigger asChild>
        <button
          type="button"
          className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-surface px-2.5 text-[13px] whitespace-nowrap hover:bg-hover"
        >
          <span className="text-muted-foreground">Sort</span>
          <span className="font-medium">{label}</span>
          <ChevronDown aria-hidden className="size-3.5 opacity-70" />
        </button>
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Content
          align="end"
          sideOffset={6}
          className="z-50 w-60 rounded-lg border border-border bg-popover p-1.5 shadow-lg"
        >
          <Menu.RadioGroup value={value} onValueChange={onChange}>
            {SORTS.map((s) => (
              <Menu.RadioItem
                key={s.key}
                value={s.key}
                className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[13px] outline-none data-[highlighted]:bg-hover"
              >
                <span className="w-4">
                  <Menu.ItemIndicator>
                    <Check className="size-4" />
                  </Menu.ItemIndicator>
                </span>
                {s.label}
              </Menu.RadioItem>
            ))}
          </Menu.RadioGroup>
        </Menu.Content>
      </Menu.Portal>
    </Menu.Root>
  )
}

function Board({
  d,
  sel,
  onPick,
}: {
  d: ActionList | undefined
  sel: string | null
  onPick: (ref: string | null) => void
}) {
  if (!d)
    return (
      <div className="grid gap-3.5 md:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-72 rounded-[10px]" />
        ))}
      </div>
    )
  const cols: { key: Priority; label: string; window: string }[] = [
    { key: "high", label: "Urgent", window: "7 days" },
    { key: "med", label: "Soon", window: "30 days" },
    { key: "low", label: "Later", window: "90 days" },
  ]
  return (
    <div className="grid items-start gap-3.5 md:grid-cols-3" role="list" aria-label="Board view">
      {cols.map((c) => {
        const rows = d.board[c.key] ?? []
        return (
          <section
            key={c.key}
            aria-label={c.label}
            className="flex flex-col rounded-[10px] border border-divider bg-sidebar"
          >
            <h2 className="m-0 flex items-center gap-2 px-3 py-2.5 text-[13.5px] font-semibold">
              <PriorityBadge priority={c.key} />
              <span className="font-normal text-muted-foreground">{c.window}</span>
              <span className="tabular ml-auto text-muted-foreground">{rows.length}</span>
            </h2>
            <ul className="m-0 flex list-none flex-col gap-2 p-2 pt-0">
              {rows.length === 0 && (
                <li className="px-2 py-4 text-center text-[13px] text-muted-foreground">Nothing here</li>
              )}
              {rows.map((r) => (
                <li key={r.id}>
                  <button
                    type="button"
                    aria-pressed={r.ref === sel}
                    onClick={() => onPick(r.ref === sel ? null : r.ref)}
                    className={cn(
                      "flex w-full flex-col gap-1 rounded-lg border bg-surface p-3 text-left hover:border-subtle",
                      r.ref === sel ? "border-st-blue shadow-[inset_3px_0_0_var(--c-blue)]" : "border-divider",
                    )}
                  >
                    <span className="flex items-center gap-2">
                      <span className="mono-id">{r.ref}</span>
                      <span className="text-[12px] text-muted-foreground">{r.type_label}</span>
                      <span
                        className={cn(
                          "ml-auto text-[12px]",
                          r.late ? "font-medium text-st-red" : "text-muted-foreground",
                        )}
                      >
                        {fmtDate(r.due_on)}
                      </span>
                    </span>
                    <span className="line-clamp-2 text-[13.5px]">{r.description}</span>
                    <span className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
                      {r.property} · {r.owner ?? "Nobody yet"}
                      <span className="ml-auto">
                        <StatusPill r={r} />
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )
      })}
    </div>
  )
}
