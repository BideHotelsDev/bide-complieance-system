/* The register item side sheet (design: One property, right panel): blocked-by-fail callout, details, evidence,
 * linked Actions, history, and the item's own buttons. */
import { useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { AlertTriangle } from "lucide-react"
import * as React from "react"

import { api, ApiError } from "@bide-comply/api-client"
import { Button } from "@bide-comply/ui/components/button"
import { Callout, Dl, ErrorState, LoadingRows, SideSheet } from "@bide-comply/ui/components/page"
import { Pill, PriorityBadge } from "@bide-comply/ui/components/status"
import { cn } from "@bide-comply/ui/lib/utils"

import { fmtDate } from "@/lib/format"
import { CertificateDialog, RaiseActionDialog, ReassignDialog, RequestDialog } from "./property-dialogs"
import type { RegisterDetail } from "./property-types"

export function StatusPill({ status, label }: { status: RegisterDetail["status"]; label: string }) {
  return (
    <Pill tone={status} dot>
      {label}
    </Pill>
  )
}

const DOER_KIND: Record<string, string> = { contractor: " (contractor)", pool: " (pool)" }

export function RegisterSheet({ refId, onClose }: { refId: string; onClose: () => void }) {
  const q = useQuery<RegisterDetail, ApiError>({
    queryKey: ["property", "register-item", refId],
    queryFn: () => api.get<RegisterDetail>(`/api/register/${refId}`),
  })
  const [dialog, setDialog] = React.useState<null | "reassign" | "cert" | "switch_off" | "pause" | "action">(null)
  const d = q.data
  return (
    <SideSheet
      label={`${refId} details`}
      onClose={onClose}
      className="lg:w-[420px]"
      header={
        <>
          <span className="mono-id text-muted-foreground">{refId}</span>
          {d && <StatusPill status={d.status} label={d.status_label} />}
          {d?.switch_off_pending && <Pill tone="blue">Switch-off waiting</Pill>}
        </>
      }
      footer={
        d && (d.can_assign || d.can_toggle) ? (
          <>
            {d.can_assign && d.kind === "certificate" && <Button onClick={() => setDialog("cert")}>Upload new certificate</Button>}
            {d.can_assign && (
              <Button variant={d.kind === "certificate" ? "outline" : "default"} onClick={() => setDialog("reassign")}>
                Reassign
              </Button>
            )}
            <Button variant="ghost" onClick={() => setDialog("action")}>
              Raise an Action
            </Button>
            {d.state === "on" && !d.switch_off_pending && (
              <span className="ml-auto flex gap-1">
                <Button variant="ghost" size="sm" onClick={() => setDialog("pause")}>
                  Pause
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setDialog("switch_off")}>
                  Switch off
                </Button>
              </span>
            )}
          </>
        ) : undefined
      }
    >
      {q.isPending ? (
        <LoadingRows rows={6} />
      ) : q.error ? (
        <ErrorState message={q.error.message} onRetry={() => void q.refetch()} />
      ) : (
        d && (
          <div className="flex flex-col gap-[18px]">
            <div>
              <h2 className="m-0 text-base font-semibold">{d.check}</h2>
              <p className="m-0 mt-1 text-muted-foreground">
                {[d.domain, `Class ${d.class}`, d.kind_label, d.legal_basis].filter(Boolean).join(" · ")}
              </p>
            </div>
            {d.blocked && (
              <Callout tone="red" icon={<AlertTriangle className="size-4" aria-hidden />}>
                {d.blocked.certificate_fail && d.certificates[0]?.issued_on
                  ? `The ${fmtDate(d.certificates[0].issued_on)} report includes a fail. `
                  : ""}
                This item cannot go Green until{" "}
                <Link
                  to="/actions"
                  search={{ sel: d.actions.find((a) => a.ref === d.blocked?.action_ref)?.id ?? d.blocked.action_ref }}
                  className="font-medium text-link underline"
                >
                  {d.blocked.action_ref}
                </Link>{" "}
                is closed with evidence.
              </Callout>
            )}
            {d.needs_owner && (
              <Callout tone="amber">This item needs a named person, pool or contractor before tasks can go out.</Callout>
            )}
            <Dl
              items={[
                {
                  label: "Done by",
                  value:
                    d.done_by === "Needs a name" ? (
                      <span className="text-st-amber">Needs a name</span>
                    ) : (
                      `${d.done_by}${DOER_KIND[d.done_by_kind ?? ""] ?? ""}`
                    ),
                },
                { label: "Accountable", value: d.accountable ?? <span className="text-st-amber">Needs a name</span> },
                ...(d.cover ? [{ label: "Cover", value: d.cover }] : []),
                {
                  label: "Frequency",
                  value: d.frequency_reason ? `${d.frequency_label} · ${d.frequency_reason}` : d.frequency_label,
                },
                { label: "Last done", value: d.last_done_label },
                { label: "Next due", value: d.next_due_text },
              ]}
            />
            {d.guidance && <p className="m-0 text-[13px] text-ink2">{d.guidance}</p>}
            <section>
              <h3 className="m-0 mb-2 text-[13.5px] font-semibold">Evidence</h3>
              {d.evidence.length === 0 ? (
                <p className="m-0 text-[13px] text-muted-foreground">Nothing filed yet.</p>
              ) : (
                <ul className="m-0 flex list-none flex-col gap-2 p-0">
                  {d.evidence.map((e) => (
                    <li key={e.id} className="flex items-center gap-2.5 rounded-lg border border-divider p-2.5">
                      <span className="inline-flex h-10 w-8 shrink-0 items-center justify-center rounded bg-hover text-[10px] font-semibold text-muted-foreground">
                        {e.kind === "pdf" ? "PDF" : "IMG"}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium">{e.name ?? "Check record"}</span>
                        <span className="block text-xs text-muted-foreground">{e.detail}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
            <section>
              <h3 className="m-0 mb-2 text-[13.5px] font-semibold">Linked Actions</h3>
              {d.actions.length === 0 ? (
                <p className="m-0 text-[13px] text-muted-foreground">No Actions raised from this item.</p>
              ) : (
                <ul className="m-0 flex list-none flex-col gap-2 p-0">
                  {d.actions.map((a) => (
                    <li key={a.id}>
                      <Link
                        to="/actions"
                        search={{ sel: a.id }}
                        className="grid grid-cols-[60px_1fr_auto] items-center gap-2 rounded-lg border border-divider p-2.5 text-foreground no-underline hover:bg-hover/50"
                      >
                        <span className="mono-id text-muted-foreground">{a.ref}</span>
                        <span className="min-w-0">
                          <span className={cn("block", a.status === "closed" && "text-muted-foreground line-through")}>
                            {a.description}
                          </span>
                          <span className="block text-xs text-muted-foreground">
                            {a.owner ?? "No owner"} · raised {fmtDate(a.raised_on)}
                          </span>
                        </span>
                        {a.status === "closed" ? (
                          <Pill tone="green">Closed</Pill>
                        ) : (
                          <span className="flex items-center gap-1">
                            <PriorityBadge priority={a.priority} />
                            <span className={cn("tabular text-xs", a.late ? "text-st-red" : "text-muted-foreground")}>
                              {fmtDate(a.due_on)}
                            </span>
                          </span>
                        )}
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </section>
            <section>
              <h3 className="m-0 mb-2 text-[13.5px] font-semibold">History</h3>
              <ol className="m-0 ml-[5px] flex list-none flex-col gap-2.5 border-l border-divider p-0">
                {d.history.map((h, i) => {
                  const when = h.at ? fmtDate(h.at) : h.date ? fmtDate(h.date) : null
                  const sub = [when, h.who].filter(Boolean).join(" · ")
                  return (
                    <li key={i} className="relative pl-3.5">
                      <span
                        aria-hidden
                        className={cn(
                          "absolute top-1.5 -left-1 size-[7px] rounded-full",
                          h.text.startsWith("Action") ? "bg-st-red" : "bg-subtle",
                        )}
                      />
                      {h.text}
                      {sub && <div className="text-xs text-muted-foreground">{sub}</div>}
                    </li>
                  )
                })}
              </ol>
            </section>
          </div>
        )
      )}
      {d && (
        <>
          <ReassignDialog open={dialog === "reassign"} onOpenChange={(o) => setDialog(o ? "reassign" : null)} item={d} />
          <CertificateDialog open={dialog === "cert"} onOpenChange={(o) => setDialog(o ? "cert" : null)} item={d} />
          <RequestDialog
            open={dialog === "switch_off" || dialog === "pause"}
            onOpenChange={(o) => !o && setDialog(null)}
            item={d}
            kind={dialog === "pause" ? "pause" : "switch_off"}
          />
          <RaiseActionDialog
            open={dialog === "action"}
            onOpenChange={(o) => setDialog(o ? "action" : null)}
            propertyId={d.property_id}
            propertyName={d.property}
            item={d}
          />
        </>
      )}
    </SideSheet>
  )
}
