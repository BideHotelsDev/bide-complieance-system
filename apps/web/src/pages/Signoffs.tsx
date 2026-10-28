/*
 * Sign-offs (design: Dutyholder.dc.html). A dutyholder director sees what is waiting for their signature, decides
 * Advisories, and signs with a statement, their typed full name and a fingerprint of the exact version (SGN-01).
 * Admins see the same per property but can't sign; requests they decide are in Approvals.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import * as React from "react"
import { CalendarClock, FileSignature, Lock, PenLine, Scale } from "lucide-react"

import { api, type ApiError } from "@bide-comply/api-client"
import { Button } from "@bide-comply/ui/components/button"
import { Callout, EmptyState, ErrorState, Skeleton } from "@bide-comply/ui/components/page"
import { ClassBadge, Pill, RagBadge } from "@bide-comply/ui/components/status"
import { toast, toastError } from "@bide-comply/ui/components/toaster"
import { cn } from "@bide-comply/ui/lib/utils"

import type { EvidenceFile, SignoffProperty, SignRequest } from "@/features/queues/types"
import { rowCls } from "@/features/queues/ui"
import { fmtDate, fmtDateTime, fmtDay } from "@/lib/format"
import { useParams } from "@/lib/params"
import { useProperty } from "@/lib/property"
import { useMe } from "@/lib/session"

type History = {
  rows: {
    id: string
    type: string
    property: string
    signer: string
    signed_name: string
    subject: string
    signed_at: string
    fingerprint: string
  }[]
}

const short = (dh: string | null) => (dh ?? "the dutyholder").split(" ")[0]

export function SignoffsPage() {
  const me = useMe()
  const [params, set] = useParams()
  const { propertyId } = useProperty()
  const res = useQuery<{ properties: SignoffProperty[] }, ApiError>({
    queryKey: ["signoffs", propertyId],
    queryFn: () => api.get("/api/signoffs", { property: propertyId ?? undefined }),
  })
  const history = useQuery<History, ApiError>({
    queryKey: ["signoffs-history"],
    queryFn: () => api.get<History>("/api/signoffs/history"),
  })
  const canSign = !!me.data?.can["sign.dutyholder"] || !!me.data?.can["sign.countersign"]
  const isAdmin = !!me.data?.is_admin

  const props = (res.data?.properties ?? []).filter((p) => p.requests.length > 0 || !isAdmin)
  const all = props.flatMap((p) => p.requests.map((r) => ({ r, p })))
  const signable = all.filter(({ r }) => r.type !== "advisory" && r.status === "open")
  const sel = all.find(({ r }) => r.id === params.sel) ?? signable[0] ?? null
  const awaiting = props.reduce((n, p) => n + p.awaiting, 0)
  const one = props.length === 1 ? props[0] : null

  if (res.error)
    return (
      <div className="rounded-[10px] border border-divider bg-surface">
        <ErrorState onRetry={() => void res.refetch()} />
      </div>
    )

  return (
    <div className="mx-auto flex w-full max-w-[1360px] flex-wrap items-start gap-6">
      <main className="flex min-w-0 flex-[999_1_520px] flex-col gap-[18px]">
        <div>
          {!res.data ? (
            <Skeleton className="h-7 w-80" />
          ) : canSign ? (
            <h1 className="m-0 text-[22px] font-semibold">
              {awaiting === 0
                ? "Nothing needs your signature"
                : `${awaiting} ${awaiting === 1 ? "thing needs" : "things need"} your signature`}
            </h1>
          ) : (
            <h1 className="m-0 text-[22px] font-semibold">Sign-offs</h1>
          )}
          <p className="m-0 mt-1 max-w-[640px] text-muted-foreground">
            {canSign && one
              ? `As dutyholder for ${one.property}, ${one.dutyholder ?? "the dutyholder"} holds the legal duties. bide does and evidences the work; you sign. Nothing here can be signed by anyone outside ${short(one.dutyholder)}'s directors.`
              : "What each dutyholder has waiting. bide does and evidences the work; only the property's dutyholder directors can sign."}
          </p>
          {isAdmin && !canSign && (
            <p className="m-0 mt-2 text-[13px] text-muted-foreground">
              You can see these but not sign them. Requests that you decide are in{" "}
              <Link to="/approvals" className="text-link">
                Approvals
              </Link>
              .
            </p>
          )}
        </div>

        {!res.data ? (
          <>
            <Skeleton className="h-20" />
            <Skeleton className="h-64" />
          </>
        ) : props.length === 0 ? (
          <div className="rounded-[10px] border border-divider bg-surface">
            <EmptyState icon={<FileSignature className="size-6" />} title="Nothing waiting for a signature">
              Fire risk assessments, quarterly register sign-offs and opening checklists appear here when they are
              ready.
            </EmptyState>
          </div>
        ) : (
          props.map((p) => (
            <PropertyBlock
              key={p.property_id}
              p={p}
              selId={sel?.r.id ?? null}
              onPick={(id) => set({ sel: id })}
              showName={props.length > 1}
              mine={canSign}
            />
          ))
        )}

        {(history.data?.rows.length ?? 0) > 0 && (
          <section className="overflow-hidden rounded-[10px] border border-divider bg-surface" aria-labelledby="signed">
            <h2 id="signed" className="m-0 border-b border-divider px-4 py-3.5 text-[14px] font-semibold">
              Signed
            </h2>
            <ul className="m-0 list-none p-0">
              {history.data!.rows.map((h) => (
                <li
                  key={h.id}
                  className="flex flex-wrap items-center gap-x-3 gap-y-0.5 border-b border-divider px-4 py-3 text-[13px] last:border-0"
                >
                  <span className="font-medium">{h.subject}</span>
                  <span className="text-muted-foreground">
                    {h.property} · {h.signed_name} · {fmtDateTime(h.signed_at)}
                  </span>
                  <span
                    className="ml-auto font-mono text-[11.5px] text-subtle"
                    title="Fingerprint of the signed version"
                  >
                    {h.fingerprint}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}
      </main>

      {sel && (
        <SignPanel
          key={sel.r.id}
          r={sel.r}
          p={sel.p}
          canSign={canSign && sel.r.can_sign !== false}
          onSigned={() => set({ sel: undefined })}
        />
      )}
    </div>
  )
}

function PropertyBlock({
  p,
  selId,
  onPick,
  showName,
  mine,
}: {
  p: SignoffProperty
  selId: string | null
  onPick: (id: string) => void
  showName: boolean
  mine: boolean
}) {
  return (
    <>
      <section
        className="grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] overflow-hidden rounded-[10px] border border-divider bg-surface"
        aria-label={`${p.property} status`}
      >
        <div className="border-r border-divider px-4 py-3.5">
          <div className="text-[12px] text-muted-foreground">
            {p.property}
            {p.town ? ` · ${p.town}` : ""}
          </div>
          <div className="mt-1">
            {p.red_line ? (
              <RagBadge status="red" label="Red · life safety open" />
            ) : (
              <RagBadge status={p.status} long />
            )}
          </div>
        </div>
        <div className="border-r border-divider px-4 py-3.5">
          <div className="text-[12px] text-muted-foreground">Life-safety checklist items open</div>
          <div className="tabular text-[20px] font-semibold">{p.gate_a_open ?? "—"}</div>
        </div>
        <div className="border-r border-divider px-4 py-3.5">
          <div className="text-[12px] text-muted-foreground">Urgent actions open</div>
          <div className="tabular text-[20px] font-semibold">{p.urgent_open}</div>
        </div>
        <div className="px-4 py-3.5">
          {p.insurer ? (
            <>
              <div className="text-[12px] text-muted-foreground">{p.insurer.label}</div>
              <div className="mt-0.5 text-[14px] font-semibold">Due {fmtDay(p.insurer.due_on)}</div>
            </>
          ) : (
            <>
              <div className="text-[12px] text-muted-foreground">Dutyholder</div>
              <div className="mt-0.5 text-[14px] font-semibold">{p.dutyholder ?? "To confirm"}</div>
            </>
          )}
        </div>
      </section>

      <section
        className="overflow-hidden rounded-[10px] border border-divider bg-surface"
        aria-labelledby={`todo-${p.code}`}
      >
        <h2 id={`todo-${p.code}`} className="m-0 border-b border-divider px-4 py-3.5 text-[14px] font-semibold">
          {mine && !showName ? "Awaiting you" : `Awaiting signature${showName ? ` · ${p.property}` : ""}`}
        </h2>
        {p.requests.length === 0 && (
          <p className="m-0 px-4 py-6 text-center text-[13px] text-muted-foreground">
            Nothing waiting at {p.property}.
          </p>
        )}
        {p.requests.map((r) => (
          <RequestItem key={r.id} r={r} on={r.id === selId} onPick={() => onPick(r.id)} />
        ))}
      </section>
    </>
  )
}

function RequestItem({ r, on, onPick }: { r: SignRequest; on: boolean; onPick: () => void }) {
  const muted = r.status === "locked" || r.status === "scheduled"
  const icon =
    r.type === "advisory" ? (
      <Scale className="size-4" />
    ) : r.status === "locked" ? (
      <Lock className="size-4" />
    ) : r.status === "scheduled" ? (
      <CalendarClock className="size-4" />
    ) : (
      <PenLine className="size-4" />
    )
  const badge =
    r.status === "locked" ? (
      <Pill tone="grey">Locked</Pill>
    ) : r.status === "scheduled" ? (
      <Pill tone="grey">Scheduled</Pill>
    ) : r.due_on ? (
      <Pill tone={new Date(r.due_on) < new Date() ? "red" : "amber"}>Due {fmtDate(r.due_on)}</Pill>
    ) : (
      <Pill tone="amber">Open</Pill>
    )
  const inner = (
    <>
      <span aria-hidden className="inline-flex size-8 items-center justify-center rounded-lg bg-st-grey-bg text-ink2">
        {icon}
      </span>
      <span className="min-w-0">
        <span className="font-medium">{r.title}</span>
        <span className={cn("block text-[12px]", !muted && "text-muted-foreground")}>{r.detail}</span>
      </span>
      {badge}
    </>
  )
  const cls = "grid grid-cols-[32px_1fr_auto] items-center gap-3 px-4 py-3.5"
  if (r.type === "advisory" && r.action_ref)
    return (
      <Link to="/actions" search={{ sel: r.action_ref }} className={cn(rowCls(false), cls)}>
        {inner}
      </Link>
    )
  if (muted)
    return (
      <div className={cn("border-b border-divider text-subtle last:border-b-0", cls)} aria-disabled>
        {inner}
      </div>
    )
  return (
    <button type="button" aria-current={on || undefined} onClick={onPick} className={cn(rowCls(on), cls)}>
      {inner}
    </button>
  )
}

function statement(r: SignRequest, p: SignoffProperty) {
  const dh = p.dutyholder ?? "the dutyholder"
  switch (r.type) {
    case "fra":
      return `I confirm I have site-walked ${p.property} and reviewed this Fire Risk Assessment and Fire Plan. I sign it on behalf of ${dh} as dutyholder.`
    case "quarterly":
      return `I have reviewed the compliance register for ${p.property} for ${r.subject ?? "this quarter"} and sign it off on behalf of ${dh}.`
    case "fra_countersign":
      return `As competent assessor I countersign the Fire Risk Assessment for ${p.property}.`
    case "gate":
      return `I confirm every applicable life-safety item on the opening checklist for ${p.property} is done with evidence. I sign on behalf of ${dh} as dutyholder.`
    default:
      return `I sign "${r.title}" on behalf of ${dh}.`
  }
}

function SignPanel({
  r,
  p,
  canSign,
  onSigned,
}: {
  r: SignRequest
  p: SignoffProperty
  canSign: boolean
  onSigned: () => void
}) {
  const qc = useQueryClient()
  const [confirm, setConfirm] = React.useState(false)
  const [name, setName] = React.useState("")
  const doc = useQuery<EvidenceFile, ApiError>({
    queryKey: ["evidence", r.evidence_id],
    queryFn: () => api.get<EvidenceFile>(`/api/evidence/${r.evidence_id}`),
    enabled: !!r.evidence_id,
    staleTime: 240_000, // signed links last five minutes
  })
  const sign = useMutation({
    mutationFn: () => api.post(`/api/signoffs/${r.id}/sign`, { confirm, full_name: name.trim() }),
    onSuccess: () => {
      toast(`Signed. Recorded with your name, the time and a fingerprint of this version.`)
      void qc.invalidateQueries({ queryKey: ["signoffs"] })
      void qc.invalidateQueries({ queryKey: ["signoffs-history"] })
      void qc.invalidateQueries({ queryKey: ["nav"] })
      onSigned()
    },
    onError: (e: ApiError) => toastError(e.message),
  })
  const [code, version] = (r.subject ?? "").split(" · ")
  const heading = r.type === "gate" ? "Sign the opening checklist" : `Sign ${code || r.title}`
  const docWord =
    r.type === "fra" ? "FRA" : r.type === "quarterly" ? "register" : r.type === "gate" ? "checklist" : "document"
  const ready = confirm && name.trim().length >= 3
  return (
    <aside
      aria-label={heading}
      className="flex max-w-full min-w-0 flex-[1_1_420px] flex-col overflow-hidden rounded-[10px] border border-divider bg-surface lg:sticky lg:top-4"
    >
      <div className="flex items-center gap-2 border-b border-divider p-4">
        <ClassBadge klass="A" />
        <span className="font-semibold">{heading}</span>
        {version && (
          <span className="ml-auto font-mono text-[12px] text-muted-foreground">
            {version.charAt(0).toUpperCase() + version.slice(1)}
          </span>
        )}
      </div>
      <div className="flex flex-col gap-3.5 p-4">
        {r.type !== "gate" && (
          <div className="overflow-hidden rounded-lg border border-divider">
            {doc.data && doc.data.content_type === "application/pdf" ? (
              <iframe
                title={`Preview of ${doc.data.file_name}`}
                src={doc.data.url}
                className="block h-[180px] w-full border-0 bg-hover"
              />
            ) : doc.data && doc.data.content_type.startsWith("image/") ? (
              <img
                src={doc.data.url}
                alt={`Preview of ${doc.data.file_name}`}
                className="block h-[180px] w-full object-cover"
              />
            ) : (
              <div className="flex h-[180px] items-center justify-center bg-hover p-4 text-center text-st-grey">
                {r.evidence_id
                  ? doc.isLoading
                    ? "Loading the document…"
                    : "Preview not available"
                  : "No document attached yet"}
              </div>
            )}
            <div className="flex items-center gap-2 px-3 py-2.5">
              <span className="min-w-0 flex-1 truncate text-[12.5px]">
                {r.file_name ?? doc.data?.file_name ?? r.title}
              </span>
              {doc.data && (
                <Button asChild variant="outline" size="sm" className="h-[26px]">
                  <a href={doc.data.url} target="_blank" rel="noreferrer">
                    Open full document
                  </a>
                </Button>
              )}
            </div>
          </div>
        )}
        {(r.preconditions?.length ?? 0) > 0 && (
          <div className="flex flex-col gap-1.5 text-[12.5px]">
            <span className="text-[13px] font-semibold">Before you sign</span>
            {r.preconditions!.map((c) => (
              <span key={c.text} className="flex gap-2">
                <Pill tone={c.done ? "green" : "amber"} className="shrink-0">
                  {c.done ? "Done" : "Open"}
                </Pill>
                {c.text}
              </span>
            ))}
          </div>
        )}
        {canSign ? (
          <>
            <label className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-border p-3">
              <input
                type="checkbox"
                checked={confirm}
                onChange={(e) => setConfirm(e.target.checked)}
                className="mt-0.5 size-4 shrink-0 accent-[var(--c-primary)]"
              />
              <span>{statement(r, p)}</span>
            </label>
            <label className="flex flex-col gap-[5px]">
              <span className="text-[12px] font-medium text-ink2">Type your full name to sign</span>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Full name"
                autoComplete="name"
                className="h-9 rounded-md border border-border bg-surface px-2.5 text-[15px] outline-none focus-visible:outline-2 focus-visible:outline-focus"
              />
            </label>
            <Button
              size="lg"
              className="justify-center"
              disabled={!ready || sign.isPending}
              onClick={() => sign.mutate()}
            >
              {sign.isPending ? "Signing…" : `Sign as ${p.dutyholder ?? "dutyholder"}`}
            </Button>
          </>
        ) : (
          <Callout tone="grey" icon={<Lock className="size-4" />}>
            Only {p.dutyholder ?? "the dutyholder"}'s directors can sign this. You can see what is waiting and chase it.
          </Callout>
        )}
        <p className="m-0 text-[12px] text-muted-foreground">
          Recorded with your name, the time and a fingerprint of this exact version (SGN-01). If the {docWord} changes
          later, it will need signing again.
        </p>
      </div>
    </aside>
  )
}
