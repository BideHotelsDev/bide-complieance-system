/*
 * Approvals (design: Approvals.dc.html): changes to what gets checked, which someone other than the person who asked
 * must decide. Tabs by kind with counts, the request list, and the request with its facts, the "check before
 * approving" note, a note (required to decline) and buttons named after the action. ?tab=<kind>&sel=<id>.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import * as React from "react"
import { CheckCircle2, Info } from "lucide-react"

import { api, type ApiError } from "@bide-comply/api-client"
import { Button } from "@bide-comply/ui/components/button"
import { Callout, EmptyState, ErrorState, Skeleton } from "@bide-comply/ui/components/page"
import { ClassBadge, Pill } from "@bide-comply/ui/components/status"
import { toast, toastError } from "@bide-comply/ui/components/toaster"
import { cn } from "@bide-comply/ui/lib/utils"

import type { ApprovalCard, ApprovalDetail, ApprovalList } from "@/features/queues/types"
import { LineTabs, Note, rowCls, textareaCls } from "@/features/queues/ui"
import { useParams } from "@/lib/params"
import { useProperty } from "@/lib/property"

const APPROVE_LABEL: Record<string, string> = {
  switch_off: "Approve switch-off",
  na: "Agree not applicable",
  missed: "Accept reason",
  cover: "Approve cover",
  pause: "Approve pause",
  backfile: "Accept record",
}
const KIND_NOUN: Record<string, string> = {
  switch_off: "switch-off requests",
  na: "not-applicable requests",
  missed: "missed reasons",
  cover: "leave cover requests",
  pause: "pause requests",
  backfile: "back-filed records",
  history: "decided requests",
}

export function ApprovalsPage() {
  const [params, set] = useParams()
  const { property } = useProperty()
  // The tab list (with counts) comes with every kind; fetch it once to pick a sensible first tab.
  const first = useQuery<ApprovalList, ApiError>({
    queryKey: ["approvals", "switch_off"],
    queryFn: () => api.get<ApprovalList>("/api/approvals", { kind: "switch_off" }),
  })
  const tabsRaw = first.data?.tabs
  const defaultTab = tabsRaw?.find((t) => t.count)?.key ?? "switch_off"
  const tab = params.tab ?? defaultTab
  const list = useQuery<ApprovalList, ApiError>({
    queryKey: ["approvals", tab],
    queryFn: () => api.get<ApprovalList>("/api/approvals", { kind: tab }),
    enabled: !!tabsRaw,
  })
  // The property switcher scopes the list (the API returns every property you can see).
  const rows = (list.data?.rows ?? []).filter((r) => !property || r.sub.startsWith(`${property.name} ·`))
  const sel = params.sel ?? rows[0]?.id ?? null
  const tabs = (tabsRaw ?? []).filter((t) => t.key !== "backfile" || t.count)

  return (
    <div className="flex flex-col gap-4">
      <nav aria-label="Breadcrumb" className="text-[12.5px] text-muted-foreground">
        <Link to="/todo" className="text-muted-foreground no-underline hover:text-foreground">
          My to-do
        </Link>{" "}
        / <span className="text-foreground">Approvals</span>
      </nav>
      <header>
        <h1 className="m-0 text-[22px] font-semibold tracking-[-0.01em]">Approvals</h1>
        <p className="m-0 mt-1 max-w-[760px] text-muted-foreground">
          Changes to what gets checked. Someone else must approve them.
        </p>
      </header>

      {first.error ? (
        <div className="rounded-[10px] border border-divider bg-surface">
          <ErrorState onRetry={() => void first.refetch()} />
        </div>
      ) : (
        <>
          {tabsRaw ? (
            <LineTabs
              label="Kinds of request"
              value={tab}
              onChange={(k) => set({ tab: k, sel: undefined })}
              tabs={tabs}
            />
          ) : (
            <Skeleton className="h-10 w-full" />
          )}
          <div className="flex flex-wrap items-start gap-5">
            <section
              aria-label="Requests"
              className="w-full overflow-hidden rounded-[10px] border border-divider bg-surface md:max-w-[440px] md:flex-[1_1_360px]"
            >
              {list.error ? (
                <ErrorState onRetry={() => void list.refetch()} />
              ) : !list.data ? (
                <div className="flex flex-col gap-2 p-3">
                  {[0, 1, 2].map((i) => (
                    <Skeleton key={i} className="h-14" />
                  ))}
                </div>
              ) : rows.length === 0 ? (
                <EmptyState
                  icon={<CheckCircle2 className="size-6" />}
                  title={tab === "history" ? "Nothing decided yet" : "Nothing waiting"}
                >
                  {tab === "history"
                    ? "Approved and declined requests appear here."
                    : `No ${KIND_NOUN[tab] ?? "requests"} waiting${property ? ` at ${property.name}` : ""}.`}
                </EmptyState>
              ) : (
                rows.map((r) => <RequestRow key={r.id} r={r} on={r.id === sel} onPick={() => set({ sel: r.id })} />)
              )}
            </section>
            <section
              aria-label="Request detail"
              className="min-w-0 flex-[999_1_480px] rounded-[10px] border border-divider bg-surface"
            >
              {sel ? (
                <Detail key={sel} id={sel} onDecided={() => set({ sel: undefined })} />
              ) : list.data ? (
                <EmptyState title="Pick a request">Choose a request on the left to see what it changes.</EmptyState>
              ) : (
                <Skeleton className="m-4 h-64" />
              )}
            </section>
          </div>
        </>
      )}
    </div>
  )
}

function StatusBadge({ s }: { s: ApprovalCard["status"] }) {
  if (s === "approved") return <Pill tone="green">Approved</Pill>
  if (s === "declined") return <Pill tone="red">Declined</Pill>
  return <Pill tone="amber">Waiting</Pill>
}

function RequestRow({ r, on, onPick }: { r: ApprovalCard; on: boolean; onPick: () => void }) {
  return (
    <button
      type="button"
      aria-current={on || undefined}
      onClick={onPick}
      className={cn(rowCls(on), "grid grid-cols-[1fr_auto] gap-2 px-[18px] py-3.5")}
    >
      <span className="min-w-0">
        <span className="font-semibold">{r.title}</span>
        <span className="block text-[12.5px] text-muted-foreground">{r.sub}</span>
        {r.status !== "waiting" && r.decided_by && (
          <span className="block text-[12.5px] text-muted-foreground">
            {r.status === "approved" ? "Approved" : "Declined"} by {r.decided_by}
          </span>
        )}
      </span>
      <StatusBadge s={r.status} />
    </button>
  )
}

function Detail({ id, onDecided }: { id: string; onDecided: () => void }) {
  const qc = useQueryClient()
  const res = useQuery<ApprovalDetail, ApiError>({
    queryKey: ["approval", id],
    queryFn: () => api.get<ApprovalDetail>(`/api/approvals/${id}`),
  })
  const [note, setNote] = React.useState("")
  const [missing, setMissing] = React.useState<"decline" | "question" | null>(null)
  const noteRef = React.useRef<HTMLTextAreaElement>(null)
  const a = res.data

  const decide = useMutation({
    mutationFn: (decision: "approve" | "decline" | "question") =>
      api.post<{ status?: string; ok?: boolean }>(`/api/approvals/${id}/decide`, {
        decision,
        note: note.trim() || null,
      }),
    onSuccess: (_r, decision) => {
      void qc.invalidateQueries({ queryKey: ["approvals"] })
      void qc.invalidateQueries({ queryKey: ["approval", id] })
      void qc.invalidateQueries({ queryKey: ["nav"] })
      if (decision === "question") {
        toast(`Question sent to ${a?.requested_by ?? "them"}`)
        setNote("")
        return
      }
      toast(
        decision === "approve"
          ? `Approved. ${a?.requested_by ?? "They"} will be told.`
          : `Declined. ${a?.requested_by ?? "They"} will be told why.`,
      )
      onDecided()
    },
    onError: (e: ApiError) => toastError(e.message),
  })

  const run = (d: "approve" | "decline" | "question") => {
    if (d !== "approve" && !note.trim()) {
      setMissing(d)
      noteRef.current?.focus()
      return
    }
    decide.mutate(d)
  }

  if (res.error)
    return (
      <ErrorState
        title={res.error.status === 404 ? "This request wasn't found" : undefined}
        onRetry={() => void res.refetch()}
      />
    )
  if (!a)
    return (
      <div className="flex flex-col gap-3 p-[18px]">
        <Skeleton className="h-6 w-3/4" />
        <Skeleton className="h-40" />
      </div>
    )
  const waiting = a.status === "waiting"
  return (
    <>
      <div className="flex items-center justify-between gap-2.5 border-b border-divider px-[18px] py-3.5">
        <h2 className="m-0 text-[15px] font-semibold">{a.title}</h2>
        <span className="flex items-center gap-2">
          {!waiting && <StatusBadge s={a.status} />}
          <ClassBadge klass={a.class} />
        </span>
      </div>
      <div className="flex flex-col gap-4 p-[18px]">
        <dl className="m-0 grid grid-cols-[150px_1fr] gap-y-2.5 max-sm:grid-cols-1">
          {a.facts.map((f) => (
            <React.Fragment key={f.label}>
              <dt className="text-muted-foreground">{f.label}</dt>
              <dd className="m-0">{f.value ?? "—"}</dd>
            </React.Fragment>
          ))}
          {a.ref && (
            <>
              <dt className="text-muted-foreground">Register item</dt>
              <dd className="m-0 font-mono text-[12px]">{a.ref}</dd>
            </>
          )}
          {!waiting && (
            <>
              <dt className="text-muted-foreground">Decided by</dt>
              <dd className="m-0">
                {a.decided_by ?? "—"}
                {a.decision_note ? `: “${a.decision_note}”` : ""}
              </dd>
            </>
          )}
        </dl>
        {a.checks.map((c) => (
          <Note key={c} icon={<Info className="size-4" />}>
            {c}
          </Note>
        ))}
        {waiting && !a.can_decide && (
          <Callout tone="grey">
            {a.own
              ? "You asked for this, so someone else must approve it."
              : "You can see this request but can't decide it."}
          </Callout>
        )}
        {waiting && a.can_decide && (
          <>
            <label className="flex flex-col gap-1.5">
              <span className="text-[12.5px] font-medium text-ink2">
                Your note <span className="font-normal text-muted-foreground">(required if you decline)</span>
              </span>
              <textarea
                ref={noteRef}
                rows={3}
                value={note}
                aria-invalid={!!missing && !note.trim()}
                onChange={(e) => {
                  setNote(e.target.value)
                  setMissing(null)
                }}
                placeholder="e.g. Confirmed on site visit, no cameras installed"
                className={cn(textareaCls, "text-[14px]", missing && !note.trim() && "border-st-red")}
              />
              {missing && !note.trim() && (
                <span role="alert" className="text-[12px] text-st-red">
                  {missing === "decline"
                    ? "Say why you're declining, so they know what to do next."
                    : "Write your question here first."}
                </span>
              )}
            </label>
            <div className="flex flex-wrap justify-end gap-2">
              <Button variant="outline" disabled={decide.isPending} onClick={() => run("question")}>
                Ask a question
              </Button>
              <Button
                variant="outline"
                className="border-st-red/30 text-st-red"
                disabled={decide.isPending}
                onClick={() => run("decline")}
              >
                Decline
              </Button>
              <Button disabled={decide.isPending} onClick={() => run("approve")}>
                {APPROVE_LABEL[a.kind] ?? "Approve"}
              </Button>
            </div>
          </>
        )}
      </div>
    </>
  )
}
