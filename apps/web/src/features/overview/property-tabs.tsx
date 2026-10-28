/* The other tabs of One property: Actions, Opening checklist, Certificates, Alarm events and People. */
import { useQuery } from "@tanstack/react-query"
import { Link, useNavigate } from "@tanstack/react-router"
import { AlertTriangle } from "lucide-react"
import type * as React from "react"

import { api, ApiError } from "@bide-comply/api-client"
import { DataTable, type ColumnDef } from "@bide-comply/ui/components/data-table"
import { QuickViews, Summary } from "@bide-comply/ui/components/filter-bar"
import { Avatar, Callout, Card, EmptyState, ErrorState, LoadingRows, NoPermission } from "@bide-comply/ui/components/page"
import { ClassBadge, GateBadge, Pill, PriorityBadge, type Tone } from "@bide-comply/ui/components/status"
import { cn } from "@bide-comply/ui/lib/utils"

import { fmtDate, fmtDateTime } from "@/lib/format"
import { useParams } from "@/lib/params"
import { useMe } from "@/lib/session"
import type { ActionRow, PropertyDetail } from "./property-types"

type ListOf<T> = { rows: T[]; total: number; summary: string; views: { key: string; label: string; count: number; on: boolean }[] }

function TableCard<T extends { id: string }>({
  q,
  columns,
  empty,
  onRowClick,
  footer,
}: {
  q: { isPending: boolean; error: ApiError | null; data?: { rows: T[] }; refetch: () => unknown }
  columns: ColumnDef<T, unknown>[]
  empty: React.ReactNode
  onRowClick?: (r: T) => void
  footer?: React.ReactNode
}) {
  return (
    <Card className="overflow-hidden">
      {q.isPending ? (
        <LoadingRows rows={6} />
      ) : q.error ? (
        <ErrorState message={q.error.message} onRetry={() => void q.refetch()} />
      ) : (
        <>
          <DataTable columns={columns} rows={q.data?.rows ?? []} empty={empty} onRowClick={onRowClick} />
          {footer}
        </>
      )}
    </Card>
  )
}

/* Actions to fix at this property */
export function ActionsTab({ property }: { property: PropertyDetail }) {
  const [p, set] = useParams()
  const navigate = useNavigate()
  const view = p.aview ?? "all"
  const q = useQuery<ListOf<ActionRow>, ApiError>({
    queryKey: ["property", property.code, "actions", view],
    queryFn: () => api.get<ListOf<ActionRow>>("/api/actions", { property: property.id, view, page_size: 100 }),
  })
  const columns: ColumnDef<ActionRow, unknown>[] = [
    { id: "ref", header: "ID", cell: ({ row }) => <span className="mono-id whitespace-nowrap">{row.original.ref}</span> },
    {
      id: "desc",
      header: "What needs fixing",
      cell: ({ row }) => (
        <span className="block max-w-[460px]">
          <span className="line-clamp-2">{row.original.description}</span>
          <span className="block text-xs text-muted-foreground">
            {row.original.type_label} · {row.original.source_label}
            {row.original.gate_ref ? ` · gate ${row.original.gate_ref}` : ""}
          </span>
        </span>
      ),
    },
    { id: "prio", header: "Priority", cell: ({ row }) => <PriorityBadge priority={row.original.priority} /> },
    {
      id: "due",
      header: "Due",
      cell: ({ row }) => (
        <span className="whitespace-nowrap">
          {fmtDate(row.original.due_on)}
          <span className={cn("block text-xs", row.original.late ? "text-st-red" : "text-muted-foreground")}>
            {row.original.left}
          </span>
        </span>
      ),
    },
    { id: "owner", header: "Owner", cell: ({ row }) => row.original.owner ?? <span className="text-st-amber">No owner</span> },
    { id: "class", header: "Class", cell: ({ row }) => <ClassBadge klass={row.original.class} /> },
    {
      id: "status",
      header: "Status",
      cell: ({ row }) => <Pill tone={row.original.status === "to_confirm" ? "amber" : "grey"}>{row.original.status_label}</Pill>,
    },
  ]
  return (
    <div className="flex flex-col gap-3">
      {q.data && <QuickViews views={q.data.views} onPick={(k) => set({ aview: k === "all" ? undefined : k })} />}
      {q.data && <Summary className="text-ink2">{q.data.summary.replace("Showing", `At ${property.name}: showing`)}</Summary>}
      <TableCard
        q={q}
        columns={columns}
        onRowClick={(r) => void navigate({ to: "/actions", search: { sel: r.id } })}
        empty={<EmptyState title="Nothing open here">No Actions to fix at {property.name} in this view.</EmptyState>}
        footer={
          <div className="border-t border-divider px-3 py-2 text-xs">
            <Link to="/actions" search={{ prop: property.code }} className="text-link">
              Open in Actions to fix
            </Link>
          </div>
        }
      />
    </div>
  )
}

/* Opening checklist: the gate summary, and a link to the full checklist */
export function OpeningTab({ property }: { property: PropertyDetail }) {
  const g = property.gate
  if (!g || g.applicable === 0)
    return (
      <Card>
        <EmptyState
          title="No opening checklist yet"
          action={
            <Link to="/gates/$code" params={{ code: property.code }} className="text-link">
              Open the opening checklist
            </Link>
          }
        >
          The checklist is made when the property is set up.
        </EmptyState>
      </Card>
    )
  return (
    <Card bodyClassName="flex flex-col gap-4 p-5">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="m-0 text-base font-semibold">Opening checklist</h2>
        <GateBadge status={g.status} />
        <Link
          to="/gates/$code"
          params={{ code: property.code }}
          className="ml-auto inline-flex h-[30px] items-center rounded-md bg-primary px-3 text-[13px] font-medium text-primary-foreground no-underline"
        >
          Open the checklist
        </Link>
      </div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {[
          { label: "Done", value: `${g.done} of ${g.applicable}`, sub: `${g.percent}%` },
          { label: "Life-safety items open", value: g.class_a_open, sub: `${g.class_a_done} of ${g.class_a_applicable} done` },
          { label: "To confirm", value: g.to_confirm, sub: "Waiting for evidence or a check" },
          { label: "Stage", value: property.stage_label, sub: property.note },
        ].map((k) => (
          <div key={k.label} className="rounded-lg border border-divider p-3">
            <div className="text-xs text-muted-foreground">{k.label}</div>
            <div className="tabular mt-1 text-xl font-semibold">{k.value}</div>
            <div className="mt-0.5 text-xs text-muted-foreground">{k.sub}</div>
          </div>
        ))}
      </div>
      {g.status === "trading_a_open" && (
        <Callout tone="red" icon={<AlertTriangle className="size-4" aria-hidden />}>
          {property.name} is trading with {g.class_a_open} life-safety items on its opening checklist still open.
        </Callout>
      )}
    </Card>
  )
}

/* Certificates at this property */
type CertRow = {
  id: string
  title: string
  why: string | null
  provider: string | null
  issued_on: string | null
  expires_on: string | null
  action_ref: string | null
  file_name: string | null
  status: string
  status_label: string
  kind_label: string
}
const CERT_TONE: Record<string, Tone> = {
  valid: "green",
  expiring: "amber",
  due: "amber",
  partial: "amber",
  expired: "red",
  fails: "red",
  missing: "outline-red",
}

export function CertificatesTab({ property }: { property: PropertyDetail }) {
  const [p, set] = useParams()
  const view = p.cview ?? "all"
  const q = useQuery<ListOf<CertRow>, ApiError>({
    queryKey: ["certificates", "property", property.id, view],
    queryFn: () => api.get<ListOf<CertRow>>("/api/certificates", { property: property.id, view, page_size: 100 }),
  })
  const columns: ColumnDef<CertRow, unknown>[] = [
    {
      id: "title",
      header: "Certificate",
      cell: ({ row }) => (
        <span>
          {row.original.title}
          {row.original.why && <span className="block text-xs text-muted-foreground">{row.original.why}</span>}
        </span>
      ),
    },
    {
      id: "status",
      header: "Status",
      cell: ({ row }) => (
        <Pill tone={CERT_TONE[row.original.status] ?? "grey"} dot={row.original.status !== "missing"}>
          {row.original.status_label}
        </Pill>
      ),
    },
    { id: "issued", header: "Issued", cell: ({ row }) => fmtDate(row.original.issued_on, true) || "—" },
    { id: "expires", header: "Expires", cell: ({ row }) => fmtDate(row.original.expires_on, true) || "—" },
    { id: "by", header: "Done by", cell: ({ row }) => row.original.provider ?? "—" },
    {
      id: "file",
      header: "File",
      cell: ({ row }) =>
        row.original.file_name ? (
          <span className="block max-w-[260px] truncate text-muted-foreground">{row.original.file_name}</span>
        ) : row.original.action_ref ? (
          <span className="text-muted-foreground">
            Action <span className="mono-id">{row.original.action_ref}</span>
          </span>
        ) : (
          "—"
        ),
    },
  ]
  return (
    <div className="flex flex-col gap-3">
      {q.data && <QuickViews views={q.data.views} onPick={(k) => set({ cview: k === "all" ? undefined : k })} />}
      {q.data && <Summary className="text-ink2">{q.data.summary}</Summary>}
      <TableCard
        q={q}
        columns={columns}
        empty={<EmptyState title="No certificates in this view" />}
        footer={
          <div className="border-t border-divider px-3 py-2 text-xs">
            <Link to="/certificates" search={{ prop: property.code }} className="text-link">
              Open in Certificates, with the expiry timeline
            </Link>
          </div>
        }
      />
    </div>
  )
}

/* Alarm events, with the 3-with-the-same-cause engineering review rule */
type AlarmRow = {
  id: string
  occurred_at: string
  zone: string | null
  cause: string | null
  false_alarm: boolean
  arc_response: string | null
  attended_minutes: number | null
  action_ref: string | null
}
type AlarmList = { rows: AlarmRow[]; causes: { cause: string; count: number; review: boolean }[] }

export function AlarmTab({ property }: { property: PropertyDetail }) {
  const q = useQuery<AlarmList, ApiError>({
    queryKey: ["property", property.code, "alarm-events"],
    queryFn: () => api.get<AlarmList>(`/api/properties/${property.code}/alarm-events`),
  })
  const columns: ColumnDef<AlarmRow, unknown>[] = [
    { id: "when", header: "When", cell: ({ row }) => <span className="whitespace-nowrap">{fmtDateTime(row.original.occurred_at)}</span> },
    { id: "zone", header: "Zone", cell: ({ row }) => row.original.zone ?? "—" },
    { id: "cause", header: "Cause", cell: ({ row }) => row.original.cause ?? "Unknown" },
    {
      id: "false",
      header: "Type",
      cell: ({ row }) => (row.original.false_alarm ? <Pill tone="amber">False alarm</Pill> : <Pill tone="red">Real</Pill>),
    },
    { id: "arc", header: "Alarm company response", cell: ({ row }) => row.original.arc_response ?? "—" },
    {
      id: "att",
      header: "Keyholder attended",
      cell: ({ row }) => (row.original.attended_minutes != null ? `${row.original.attended_minutes} min` : "—"),
    },
    {
      id: "act",
      header: "Action",
      cell: ({ row }) => (row.original.action_ref ? <span className="mono-id">{row.original.action_ref}</span> : "—"),
    },
  ]
  const review = q.data?.causes.filter((c) => c.review) ?? []
  return (
    <div className="flex flex-col gap-3">
      {review.map((c) => (
        <Callout key={c.cause} tone="red" icon={<AlertTriangle className="size-4" aria-hidden />}>
          {c.count} false alarms with the same cause ({c.cause.toLowerCase()}) in 90 days. Three with the same cause means
          an engineering review of the system.
        </Callout>
      ))}
      {q.data && q.data.causes.length > 0 && (
        <Summary className="text-ink2">
          False alarms in the last 90 days by cause:{" "}
          {q.data.causes.map((c) => `${c.cause} ${c.count}${c.review ? " (engineering review)" : ""}`).join(" · ")}.
        </Summary>
      )}
      <TableCard
        q={q}
        columns={columns}
        empty={
          <EmptyState title="No alarm events logged">
            Fire alarm activations and false alarms at {property.name} appear here when they're logged.
          </EmptyState>
        }
      />
    </div>
  )
}

/* People with a role at this property */
type PersonRow = {
  id: string
  name: string
  initials: string
  title: string | null
  roles: { role: string; label: string; property: string }[]
  training: string
  training_tone: "red" | "amber" | "green"
  last_active: string
}

export function PeopleTab({ property }: { property: PropertyDetail }) {
  const me = useMe()
  const navigate = useNavigate()
  const allowed = !!me.data?.can["people.view"]
  const q = useQuery<ListOf<PersonRow>, ApiError>({
    queryKey: ["property", property.code, "people"],
    queryFn: () => api.get<ListOf<PersonRow>>("/api/people", { prop: property.code, page_size: 100 }),
    enabled: allowed,
  })
  if (!allowed) return <NoPermission message="People are visible to the system owner and directors." />
  const columns: ColumnDef<PersonRow, unknown>[] = [
    {
      id: "name",
      header: "Name",
      cell: ({ row }) => (
        <span className="flex items-center gap-2.5">
          <Avatar initials={row.original.initials} />
          <span>
            <span className="block font-medium">{row.original.name}</span>
            <span className="block text-xs text-muted-foreground">{row.original.title}</span>
          </span>
        </span>
      ),
    },
    {
      id: "roles",
      header: "Roles here",
      cell: ({ row }) =>
        row.original.roles
          .filter((r) => r.property === property.name || r.property === "All properties")
          .map((r) => r.label)
          .join(", "),
    },
    {
      id: "training",
      header: "Training",
      cell: ({ row }) => (
        <Pill tone={row.original.training_tone} dot>
          {row.original.training}
        </Pill>
      ),
    },
    { id: "last", header: "Last active", cell: ({ row }) => row.original.last_active },
  ]
  return (
    <div className="flex flex-col gap-3">
      {q.data && <Summary className="text-ink2">{q.data.summary}</Summary>}
      <TableCard
        q={q}
        columns={columns}
        onRowClick={(r) => void navigate({ to: "/settings/people", search: { sel: r.id } })}
        empty={<EmptyState title="Nobody has a role here yet">Add people in Settings › People.</EmptyState>}
      />
    </div>
  )
}
