/*
 * Data tables (PRD §10.5, design: Components › Data table anatomy). Server-side pagination, sorting and filtering:
 * this renders one page and reports clicks. Sticky header and first column, aria-sort, numbers right-aligned in
 * tabular figures, row actions at the end, a bulk bar that replaces the toolbar while rows are selected, and cards
 * on phones. Density (Comfortable 48px / Compact 36px) is remembered per user by the caller.
 */
import * as React from "react"
import { flexRender, getCoreRowModel, useReactTable, type ColumnDef, type RowSelectionState } from "@tanstack/react-table"
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight } from "lucide-react"

import { cn } from "../lib/utils"

export type { ColumnDef }

export type SortState = { id: string; desc: boolean } | null

type Meta = { align?: "right" | "left"; sortable?: boolean; className?: string; headerClassName?: string; mono?: boolean }

export function DataTable<T extends { id: string }>({
  columns,
  rows,
  onRowClick,
  selectedId,
  sort,
  onSort,
  selectable = false,
  selection,
  onSelectionChange,
  bulkBar,
  density = "comfortable",
  groups,
  caption,
  empty,
  mobileCard,
}: {
  columns: ColumnDef<T, unknown>[]
  rows: T[]
  onRowClick?: (row: T) => void
  selectedId?: string | null
  sort?: SortState
  onSort?: (s: SortState) => void
  selectable?: boolean
  selection?: RowSelectionState
  onSelectionChange?: (s: RowSelectionState) => void
  bulkBar?: (selectedIds: string[]) => React.ReactNode
  density?: "comfortable" | "compact"
  groups?: { key: string; label: React.ReactNode; ids: string[] }[]
  caption?: string
  empty?: React.ReactNode
  mobileCard?: (row: T) => React.ReactNode
}) {
  const [innerSel, setInnerSel] = React.useState<RowSelectionState>({})
  const sel = selection ?? innerSel
  const setSel = onSelectionChange ?? setInnerSel
  const table = useReactTable({
    data: rows,
    columns,
    getRowId: (r) => r.id,
    getCoreRowModel: getCoreRowModel(),
    manualSorting: true,
    manualPagination: true,
    enableRowSelection: selectable,
    state: { rowSelection: sel },
    onRowSelectionChange: (u) => setSel(typeof u === "function" ? u(sel) : u),
  })
  const selectedIds = Object.keys(sel).filter((k) => sel[k])
  const rowH = density === "compact" ? "h-9" : "h-12"
  const byId = new Map(table.getRowModel().rows.map((r) => [r.id, r]))
  const renderRow = (id: string) => {
    const r = byId.get(id)
    if (!r) return null
    const on = selectedId === r.id
    return (
      <tr
        key={r.id}
        aria-selected={on || undefined}
        onClick={onRowClick ? () => onRowClick(r.original) : undefined}
        onKeyDown={
          onRowClick
            ? (e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault()
                  onRowClick(r.original)
                }
              }
            : undefined
        }
        tabIndex={onRowClick ? 0 : undefined}
        className={cn(
          "border-b border-divider last:border-0",
          onRowClick && "cursor-pointer hover:bg-hover/60 focus-visible:bg-hover",
          on && "bg-st-blue-bg/60 shadow-[inset_3px_0_0_var(--c-blue)]",
        )}
      >
        {selectable && (
          <td className="w-9 pl-3" onClick={(e) => e.stopPropagation()}>
            <input
              type="checkbox"
              aria-label={`Select ${r.id}`}
              checked={r.getIsSelected()}
              onChange={r.getToggleSelectedHandler()}
              className="size-4 accent-[var(--c-primary)]"
            />
          </td>
        )}
        {r.getVisibleCells().map((c, i) => {
          const meta = (c.column.columnDef.meta ?? {}) as Meta
          return (
            <td
              key={c.id}
              className={cn(
                rowH,
                "px-3 py-1.5 align-middle text-[13.5px]",
                meta.align === "right" && "tabular text-right",
                i === 0 && "sticky left-0 bg-inherit",
                meta.className,
              )}
            >
              {flexRender(c.column.columnDef.cell, c.getContext())}
            </td>
          )
        })}
      </tr>
    )
  }
  const cols = (selectable ? 1 : 0) + columns.length
  return (
    <div className="relative">
      {selectable && selectedIds.length > 0 && bulkBar && (
        <div className="sticky top-0 z-20 flex items-center gap-2 border-b border-border bg-primary px-3 py-2 text-[13px] text-primary-foreground">
          <span className="font-medium">{selectedIds.length} selected</span>
          <div className="flex items-center gap-1.5">{bulkBar(selectedIds)}</div>
          <button type="button" className="ml-auto underline" onClick={() => setSel({})}>
            Clear selection
          </button>
        </div>
      )}
      <div className={cn("overflow-x-auto", mobileCard && "hidden md:block")}>
        <table className="w-full border-collapse">
          {caption && <caption className="sr-only">{caption}</caption>}
          <thead className="sticky top-0 z-10">
            {table.getHeaderGroups().map((hg) => (
              <tr key={hg.id}>
                {selectable && (
                  <th className="h-[34px] w-9 border-b border-divider bg-background pl-3">
                    <input
                      type="checkbox"
                      aria-label="Select all on this page"
                      checked={table.getIsAllRowsSelected()}
                      onChange={table.getToggleAllRowsSelectedHandler()}
                      className="size-4 accent-[var(--c-primary)]"
                    />
                  </th>
                )}
                {hg.headers.map((h, i) => {
                  const meta = (h.column.columnDef.meta ?? {}) as Meta
                  const sorted = sort && sort.id === h.column.id ? (sort.desc ? "descending" : "ascending") : undefined
                  const canSort = meta.sortable && onSort
                  return (
                    <th
                      key={h.id}
                      scope="col"
                      aria-sort={sorted ?? (canSort ? "none" : undefined)}
                      className={cn(
                        "h-[34px] border-b border-divider bg-background px-3 text-left text-xs font-medium whitespace-nowrap text-muted-foreground",
                        meta.align === "right" && "text-right",
                        i === 0 && "sticky left-0 z-10",
                        meta.headerClassName,
                      )}
                    >
                      {canSort ? (
                        <button
                          type="button"
                          className="inline-flex items-center gap-1 hover:text-foreground"
                          onClick={() =>
                            onSort(
                              sort && sort.id === h.column.id
                                ? { id: h.column.id, desc: !sort.desc }
                                : { id: h.column.id, desc: false },
                            )
                          }
                        >
                          {flexRender(h.column.columnDef.header, h.getContext())}
                          {sorted === "ascending" && <ArrowUp aria-hidden className="size-3" />}
                          {sorted === "descending" && <ArrowDown aria-hidden className="size-3" />}
                        </button>
                      ) : (
                        flexRender(h.column.columnDef.header, h.getContext())
                      )}
                    </th>
                  )
                })}
              </tr>
            ))}
          </thead>
          <tbody className="bg-surface">
            {rows.length === 0 && empty ? (
              <tr>
                <td colSpan={cols} className="p-0">
                  {empty}
                </td>
              </tr>
            ) : groups ? (
              groups.map((g) => (
                <React.Fragment key={g.key}>
                  <tr>
                    <td
                      colSpan={cols}
                      className="border-b border-divider bg-sidebar px-3 py-1.5 text-xs font-semibold text-ink2"
                    >
                      {g.label}
                    </td>
                  </tr>
                  {g.ids.map(renderRow)}
                </React.Fragment>
              ))
            ) : (
              rows.map((r) => renderRow(r.id))
            )}
          </tbody>
        </table>
      </div>
      {mobileCard && (
        <ul className="flex flex-col gap-2 md:hidden">
          {rows.length === 0 && empty}
          {rows.map((r) => (
            <li key={r.id}>
              <button
                type="button"
                onClick={onRowClick ? () => onRowClick(r) : undefined}
                className="w-full rounded-lg border border-border bg-surface p-3 text-left"
              >
                {mobileCard(r)}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

export function Pagination({
  page,
  pageSize,
  total,
  noun = "items",
  onPage,
  onPageSize,
}: {
  page: number
  pageSize: number
  total: number
  noun?: string
  onPage: (p: number) => void
  onPageSize?: (n: number) => void
}) {
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1
  const to = Math.min(total, page * pageSize)
  const last = Math.max(1, Math.ceil(total / pageSize))
  return (
    <div className="flex flex-wrap items-center gap-3 px-3 py-2.5 text-[13px] text-muted-foreground">
      <span className="tabular">
        {from}–{to} of {total} {noun}
      </span>
      <span className="ml-auto flex items-center gap-2">
        {onPageSize && (
          <label className="flex items-center gap-1.5">
            Rows per page
            <select
              value={pageSize}
              onChange={(e) => onPageSize(Number(e.target.value))}
              className="h-7 rounded-md border border-border bg-surface px-1.5 text-foreground"
            >
              {[25, 50, 100].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
        )}
        <button
          type="button"
          aria-label="Previous page"
          disabled={page <= 1}
          onClick={() => onPage(page - 1)}
          className="inline-flex size-7 items-center justify-center rounded-md border border-border bg-surface disabled:opacity-40"
        >
          <ChevronLeft className="size-4" />
        </button>
        <button
          type="button"
          aria-label="Next page"
          disabled={page >= last}
          onClick={() => onPage(page + 1)}
          className="inline-flex size-7 items-center justify-center rounded-md border border-border bg-surface disabled:opacity-40"
        >
          <ChevronRight className="size-4" />
        </button>
      </span>
    </div>
  )
}
