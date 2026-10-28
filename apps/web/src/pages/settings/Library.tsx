/*
 * Settings › Compliance library (design: Library). Every check bide does, by area, with the version staff are on and
 * where it is used. New templates start from a sensible default form; archiving keeps every past record.
 */
import * as React from "react"
import { Link, useNavigate } from "@tanstack/react-router"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { MoreHorizontal } from "lucide-react"
import { api, ApiError } from "@bide-comply/api-client"
import { Button } from "@bide-comply/ui/components/button"
import { DataTable, Pagination, type ColumnDef } from "@bide-comply/ui/components/data-table"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@bide-comply/ui/components/dropdown-menu"
import { FilterBar, SearchBox, Segmented, Summary, type Facet } from "@bide-comply/ui/components/filter-bar"
import { EmptyState, ErrorState, LoadingRows, NoPermission, PageHeader } from "@bide-comply/ui/components/page"
import { ClassBadge, Pill } from "@bide-comply/ui/components/status"
import { toast } from "@bide-comply/ui/components/toaster"
import { cn } from "@bide-comply/ui/lib/utils"

import { ArchiveDialog, useLibraryOptions } from "../../features/settings-a/library"
import { ActionDialog, errMsg, Labeled, NativeSelect, TextInput } from "../../features/settings-a/ui"
import { plural } from "../../lib/format"
import { list, useParams } from "../../lib/params"
import { useMe } from "../../lib/session"

type Row = {
  id: string
  name: string
  legal_basis: string
  applies_note: string | null
  class: "A" | "B" | "C"
  kind: string
  kind_label: string
  frequency: string
  frequency_label: string
  version: number
  draft: number | null
  status: string
  domain: string
  used_at: number
}
type Area = { key: string; label: string; count: number }
type LibraryList = {
  rows: Row[]
  total: number
  page: number
  page_size: number
  facets: Facet[]
  summary: string
  any_filter: boolean
  areas: Area[]
}

export function LibraryPage() {
  const me = useMe()
  const [p, set] = useParams()
  const navigate = useNavigate()
  const page = Number(p.page ?? 1)
  const q = useQuery({
    queryKey: ["library", p],
    queryFn: () =>
      api.get<LibraryList>("/api/library", {
        q: p.q,
        area: p.area,
        class: list(p.class),
        kind: list(p.kind),
        how_often: list(p.how_often),
        page,
        page_size: 12,
      }),
    placeholderData: (prev) => prev,
  })
  const canEdit = !!me.data?.can["library.edit"]
  const [creating, setCreating] = React.useState(false)
  const [archiving, setArchiving] = React.useState<Row | null>(null)
  const qc = useQueryClient()
  const restore = useMutation({
    mutationFn: (r: Row) => api.post(`/api/library/${r.id}/restore`),
    onSuccess: (_x, r) => {
      void qc.invalidateQueries({ queryKey: ["library"] })
      toast(`Brought back “${r.name}”. Switch it on per property in Property setup.`)
    },
    onError: (e) => toast(errMsg(e)),
  })

  if (q.error instanceof ApiError && q.error.status === 403) return <NoPermission />

  const area = p.area ?? "all"
  const main = q.data?.areas.filter((a) => a.key !== "proposed" && a.key !== "archived") ?? []
  const extra = q.data?.areas.filter((a) => a.key === "proposed" || a.key === "archived") ?? []
  const open = (r: Row) => void navigate({ to: "/settings/library/$id", params: { id: r.id } })

  const columns: ColumnDef<Row, unknown>[] = [
    {
      id: "template",
      header: "Template",
      cell: ({ row: { original: r } }) => (
        <div className="min-w-[300px] py-0.5 lg:min-w-[360px]">
          <Link
            to="/settings/library/$id"
            params={{ id: r.id }}
            onClick={(e) => e.stopPropagation()}
            className="font-medium text-foreground no-underline hover:underline"
          >
            {r.name}
          </Link>
          <div className="text-xs text-muted-foreground">
            {[
              r.legal_basis,
              r.applies_note && !r.legal_basis.toLowerCase().includes(r.applies_note.toLowerCase())
                ? r.applies_note
                : null,
            ]
              .filter(Boolean)
              .join(" · ") || "No legal basis recorded"}
          </div>
        </div>
      ),
    },
    { id: "class", header: "Class", cell: ({ row }) => <ClassBadge klass={row.original.class} /> },
    {
      id: "type",
      header: "Type",
      cell: ({ row }) => <span className="whitespace-nowrap">{row.original.kind_label}</span>,
    },
    {
      id: "how_often",
      header: "How often",
      cell: ({ row }) => <span className="whitespace-nowrap">{row.original.frequency_label}</span>,
    },
    {
      id: "version",
      header: "Version",
      cell: ({ row: { original: r } }) =>
        r.draft ? (
          <Pill tone="amber" title={`v${r.version} is live; v${r.draft} is a draft nobody sees yet`}>
            v{r.draft} draft
          </Pill>
        ) : (
          <Pill tone="grey">v{r.version}</Pill>
        ),
    },
    {
      id: "used_at",
      header: "Used at",
      cell: ({ row: { original: r } }) => (
        <span className={cn("whitespace-nowrap", r.used_at === 0 && "text-muted-foreground")}>
          {r.used_at === 0 ? "Not used yet" : plural(r.used_at, "property", "properties")}
        </span>
      ),
    },
  ]
  if (canEdit)
    columns.push({
      id: "actions",
      header: () => <span className="sr-only">Actions</span>,
      meta: { className: "w-10 pr-2" },
      cell: ({ row: { original: r } }) => (
        <div onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${r.name}`}>
                <MoreHorizontal />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => open(r)}>
                {r.status === "archived" ? "View template" : "Edit template"}
              </DropdownMenuItem>
              {r.status === "archived" ? (
                <DropdownMenuItem onSelect={() => restore.mutate(r)}>Bring back</DropdownMenuItem>
              ) : (
                <DropdownMenuItem variant="destructive" onSelect={() => setArchiving(r)}>
                  Archive…
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      ),
    })

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Compliance library"
        subtitle="Every check bide does, and the questions staff answer."
        actions={
          canEdit && (
            <>
              <Button variant="outline" asChild>
                <Link to="/settings/import">Import</Link>
              </Button>
              <Button onClick={() => setCreating(true)}>New template</Button>
            </>
          )
        }
      />
      <div className="flex flex-col gap-5 lg:flex-row">
        <aside aria-label="Areas" className="lg:w-[200px] lg:shrink-0">
          <div className="px-2.5 pb-2 text-xs font-medium text-ink2">Area</div>
          {!q.data && q.isLoading && <LoadingRows rows={8} />}
          <nav className="flex gap-1 overflow-x-auto lg:flex-col lg:overflow-visible">
            {main.map((a) => (
              <AreaLink
                key={a.key}
                a={a}
                on={area === a.key}
                onPick={() => set({ area: a.key === "all" ? undefined : a.key, page: undefined })}
              />
            ))}
            {extra.length > 0 && <div className="my-2 hidden border-t border-divider lg:block" />}
            {extra.map((a) => (
              <AreaLink
                key={a.key}
                a={a}
                on={area === a.key}
                tone={a.key === "proposed" && a.count > 0 ? "amber" : undefined}
                onPick={() => set({ area: a.key, page: undefined })}
              />
            ))}
          </nav>
        </aside>
        <div className="flex min-w-0 flex-1 flex-col gap-3">
          <FilterBar
            facets={q.data?.facets ?? []}
            onFacet={(k, v) => set({ [k]: v.join(",") || undefined, page: undefined })}
            search={
              <SearchBox
                value={p.q ?? ""}
                onChange={(v) => set({ q: v || undefined, page: undefined })}
                placeholder="Search templates and standards"
              />
            }
            anyFilter={q.data?.any_filter}
            onClearAll={() =>
              set({ q: undefined, class: undefined, kind: undefined, how_often: undefined, page: undefined })
            }
          />
          {q.data && <Summary>{q.data.summary}</Summary>}
          <div className="overflow-hidden rounded-[10px] border border-divider bg-surface">
            {q.error ? (
              <ErrorState message={errMsg(q.error)} onRetry={() => void q.refetch()} />
            ) : !q.data ? (
              <LoadingRows rows={8} />
            ) : (
              <>
                <DataTable
                  columns={columns}
                  rows={q.data.rows}
                  onRowClick={open}
                  caption="Compliance library templates"
                  empty={
                    <EmptyState
                      title={
                        area === "proposed"
                          ? "No proposed additions"
                          : area === "archived"
                            ? "Nothing archived"
                            : "No templates match"
                      }
                      action={
                        q.data.any_filter && (
                          <Button
                            variant="outline"
                            onClick={() =>
                              set({ q: undefined, class: undefined, kind: undefined, how_often: undefined })
                            }
                          >
                            Clear all filters
                          </Button>
                        )
                      }
                    >
                      {area === "archived"
                        ? "Archived templates appear here, with every past record kept."
                        : q.data.any_filter
                          ? "Try fewer filters or a different search."
                          : "Add one with New template, or import the register Sheet."}
                    </EmptyState>
                  }
                  mobileCard={(r) => (
                    <div className="flex flex-col gap-1">
                      <div className="flex items-center gap-2">
                        <ClassBadge klass={r.class} />
                        <span className="font-medium">{r.name}</span>
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {r.kind_label} · {r.frequency_label} · v{r.draft ?? r.version}
                        {r.draft ? " draft" : ""} · {plural(r.used_at, "property", "properties")}
                      </div>
                    </div>
                  )}
                />
                <div className="border-t border-divider">
                  <Pagination
                    page={q.data.page}
                    pageSize={q.data.page_size}
                    total={q.data.total}
                    noun="templates"
                    onPage={(n) => set({ page: n === 1 ? undefined : String(n) })}
                  />
                </div>
              </>
            )}
          </div>
        </div>
      </div>
      {creating && <NewTemplateDialog onClose={() => setCreating(false)} defaultArea={area} />}
      {archiving && <ArchiveDialog row={archiving} onClose={() => setArchiving(null)} />}
    </div>
  )
}

function AreaLink({ a, on, onPick, tone }: { a: Area; on: boolean; onPick: () => void; tone?: "amber" }) {
  return (
    <button
      type="button"
      aria-current={on ? "true" : undefined}
      onClick={onPick}
      className={cn(
        "flex h-9 shrink-0 items-center justify-between gap-3 rounded-md px-2.5 text-left text-[13.5px] whitespace-nowrap",
        on ? "bg-hover font-medium text-foreground" : "text-ink2 hover:bg-hover/60",
      )}
    >
      <span>{a.label}</span>
      {tone === "amber" ? (
        <Pill tone="amber" className="h-[18px] px-1.5 text-[11.5px]">
          {a.count}
        </Pill>
      ) : (
        <span className="tabular text-[12.5px] text-muted-foreground">{a.count}</span>
      )}
    </button>
  )
}

function NewTemplateDialog({ onClose, defaultArea }: { onClose: () => void; defaultArea: string }) {
  const opts = useLibraryOptions()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [name, setName] = React.useState("")
  const [domainId, setDomainId] = React.useState("")
  const [klass, setKlass] = React.useState<"A" | "B" | "C">("B")
  const [kind, setKind] = React.useState("check")
  const [frequency, setFrequency] = React.useState("monthly")
  const [error, setError] = React.useState<string | null>(null)
  React.useEffect(() => {
    if (opts.data && !domainId)
      setDomainId((opts.data.domains.find((d) => d.key === defaultArea) ?? opts.data.domains[0])?.id ?? "")
  }, [opts.data, domainId, defaultArea])
  const m = useMutation({
    mutationFn: () =>
      api.post<{ id: string }>("/api/library", {
        name,
        domain_id: domainId,
        klass,
        kind,
        default_frequency: frequency,
      }),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ["library"] })
      toast(`Added “${name.trim()}”. Build its form next.`)
      onClose()
      void navigate({ to: "/settings/library/$id", params: { id: r.id } })
    },
    onError: (e) => setError(errMsg(e)),
  })
  const ok = name.trim().length >= 3 && !!domainId
  return (
    <ActionDialog
      open
      onOpenChange={(o) => !o && onClose()}
      busy={m.isPending}
      title="New template"
      subtitle="It starts with a simple form: done, a photo and notes. You can change the questions next."
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!ok || m.isPending} onClick={() => m.mutate()}>
            {m.isPending ? "Adding…" : "Add template"}
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault()
          if (ok) m.mutate()
        }}
      >
        <Labeled label="Name" htmlFor="nt-name">
          <TextInput
            id="nt-name"
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Weekly pool chemical test"
          />
        </Labeled>
        <div className="grid grid-cols-2 gap-3">
          <Labeled label="Area" htmlFor="nt-area">
            <NativeSelect
              id="nt-area"
              value={domainId}
              onChange={(e) => setDomainId(e.target.value)}
              options={(opts.data?.domains ?? []).map((d) => ({ value: d.id, label: d.name }))}
            />
          </Labeled>
          <Labeled label="Type" htmlFor="nt-kind">
            <NativeSelect
              id="nt-kind"
              value={kind}
              onChange={(e) => setKind(e.target.value)}
              options={(opts.data?.kinds ?? []).map((k) => ({ value: k.key, label: k.label }))}
            />
          </Labeled>
        </div>
        <Labeled label="Class">
          <Segmented
            label="Class"
            value={klass}
            onChange={setKlass}
            options={[
              { value: "A", label: "A · Life safety" },
              { value: "B", label: "B · Statutory" },
              { value: "C", label: "C · bide standard" },
            ]}
          />
        </Labeled>
        <Labeled label="Default frequency" htmlFor="nt-freq">
          <NativeSelect
            id="nt-freq"
            value={frequency}
            onChange={(e) => setFrequency(e.target.value)}
            options={(opts.data?.frequencies ?? []).map((f) => ({ value: f.key, label: f.label }))}
          />
        </Labeled>
        {error && (
          <div role="alert" className="text-[13px] text-st-red">
            {error}
          </div>
        )}
      </form>
    </ActionDialog>
  )
}
