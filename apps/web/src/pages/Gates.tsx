/* Opening checklists: one row per property's checklist (BH-CMP-002), each opening the full checklist at /gates/<code>. */
import { useQuery } from "@tanstack/react-query"
import { Link, useNavigate } from "@tanstack/react-router"
import * as React from "react"
import { ClipboardCheck } from "lucide-react"

import { api, type ApiError } from "@bide-comply/api-client"
import { DataTable, type ColumnDef } from "@bide-comply/ui/components/data-table"
import { EmptyState, ErrorState, LoadingRows, PageHeader } from "@bide-comply/ui/components/page"
import { GateBadge } from "@bide-comply/ui/components/status"
import { cn } from "@bide-comply/ui/lib/utils"

import type { GateRow } from "@/features/queues/types"
import { Progress } from "@/features/queues/ui"
import { fmtDate } from "@/lib/format"
import { useProperty } from "@/lib/property"

const STAGE: Record<string, string> = { trading: "Trading", pre_opening: "Opening soon", setup: "Being set up" }

export function GatesPage() {
  const navigate = useNavigate()
  const { propertyId } = useProperty()
  const res = useQuery<{ rows: GateRow[] }, ApiError>({ queryKey: ["gates"], queryFn: () => api.get("/api/gates") })
  const rows = (res.data?.rows ?? []).filter((r) => !propertyId || r.property_id === propertyId)

  const columns = React.useMemo<ColumnDef<GateRow & { id: string }, unknown>[]>(
    () => [
      {
        id: "property",
        header: "Property",
        cell: ({ row: { original: r } }) => (
          <Link to="/gates/$code" params={{ code: r.code }} className="text-foreground no-underline hover:underline" onClick={(e) => e.stopPropagation()}>
            <span className="font-medium">{r.property}</span> <span className="mono-id">{r.code}</span>
          </Link>
        ),
      },
      { id: "status", header: "Gate", cell: ({ row: { original: r } }) => <GateBadge status={r.status} /> },
      {
        id: "done",
        header: "Done",
        cell: ({ row: { original: r } }) => (
          <span className="flex min-w-[160px] items-center gap-2.5">
            <Progress value={r.done} total={r.applicable} className="w-24" />
            <span className="tabular text-[12.5px] text-muted-foreground">
              {r.done} of {r.applicable} · {r.percent}%
            </span>
          </span>
        ),
      },
      {
        id: "a_open",
        header: "Life-safety open",
        meta: { align: "right" },
        cell: ({ row: { original: r } }) => (
          <span className={cn("font-semibold", r.class_a_open ? "text-st-red" : "text-muted-foreground")}>{r.class_a_open}</span>
        ),
      },
      { id: "to_confirm", header: "To confirm", meta: { align: "right" }, cell: ({ row: { original: r } }) => r.to_confirm },
      { id: "actions", header: "Actions open", meta: { align: "right" }, cell: ({ row: { original: r } }) => r.actions_open },
      {
        id: "stage",
        header: "Stage",
        cell: ({ row: { original: r } }) => (
          <span className="text-[13px]">
            {STAGE[r.stage] ?? r.stage}
            {r.opening_date && (
              <span className="block text-[12px] text-muted-foreground">
                {r.stage === "trading" ? "since" : "opens"} {fmtDate(r.opening_date, true)}
              </span>
            )}
          </span>
        ),
      },
    ],
    [],
  )

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Opening checklists"
        subtitle="Everything that must be done before guests stay. Every life-safety item must be done with evidence before the dutyholder signs."
      />
      <div className="overflow-hidden rounded-[10px] border border-divider bg-surface">
        {res.error ? (
          <ErrorState onRetry={() => void res.refetch()} />
        ) : !res.data ? (
          <LoadingRows rows={4} label="Loading opening checklists" />
        ) : (
          <DataTable
            columns={columns}
            rows={rows.map((r) => ({ ...r, id: r.property_id }))}
            caption="Opening checklists"
            onRowClick={(r) => void navigate({ to: "/gates/$code", params: { code: r.code } })}
            empty={
              <EmptyState icon={<ClipboardCheck className="size-6" />} title="No opening checklists yet">
                A checklist is created when a property is set up. Add one in Settings › Property setup.
              </EmptyState>
            }
            mobileCard={(r) => (
              <div className="flex flex-col gap-1.5">
                <div className="flex items-center gap-2">
                  <span className="font-medium">{r.property}</span>
                  <GateBadge status={r.status} className="ml-auto" />
                </div>
                <Progress value={r.done} total={r.applicable} />
                <span className="text-[12.5px] text-muted-foreground">
                  {r.done} of {r.applicable} done · {r.class_a_open} life-safety open · {r.to_confirm} to confirm
                </span>
              </div>
            )}
          />
        )}
      </div>
    </div>
  )
}
