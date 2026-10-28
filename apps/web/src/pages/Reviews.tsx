/*
 * Evidence review (design: Verify.dc.html). A queue on the left (Needs review / Spot-check / Back-filed), one
 * submission's evidence on the right. Reject needs a comment; Approve marks it Verified and locks it; corrections
 * after that are amendments with a reason (design: Dialogs › Add a correction). Your own submissions never appear.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import * as React from "react"
import { Check, ChevronLeft, ChevronRight, EyeOff, Inbox, Lock } from "lucide-react"

import { api, type ApiError } from "@bide-comply/api-client"
import { Button } from "@bide-comply/ui/components/button"
import { Callout, EmptyState, ErrorState, NoPermission, Skeleton } from "@bide-comply/ui/components/page"
import { ClassBadge, FlagBadge, Pill, type Tone } from "@bide-comply/ui/components/status"
import { toast, toastError } from "@bide-comply/ui/components/toaster"
import { cn } from "@bide-comply/ui/lib/utils"

import type { QueueCard, ReviewDetail, ReviewQueue } from "@/features/queues/types"
import { Field, inputCls, isTyping, LineTabs, Note, QDialog, Radio, rowCls, textareaCls } from "@/features/queues/ui"
import { fmtDateTime } from "@/lib/format"
import { useParams } from "@/lib/params"
import { useProperty } from "@/lib/property"
import { useMe } from "@/lib/session"

const STATUS: Record<string, { tone: Tone; label: string }> = {
  submitted: { tone: "blue", label: "Submitted" },
  failed: { tone: "red", label: "Failed" },
  passed: { tone: "green", label: "Passed" },
  verified: { tone: "green", label: "Verified" },
  open: { tone: "grey", label: "Reopened" },
}

export function ReviewsPage() {
  const me = useMe()
  const [params, set] = useParams()
  const { propertyId, property } = useProperty()
  const qc = useQueryClient()
  const queue = params.queue ?? "needs_review"
  const [bulk, setBulk] = React.useState(false)

  const list = useQuery<ReviewQueue, ApiError>({
    queryKey: ["reviews", queue, propertyId],
    queryFn: () => api.get<ReviewQueue>("/api/reviews", { queue, property: propertyId ?? undefined }),
    enabled: !!me.data?.can.verify,
  })
  const rows = list.data?.rows ?? []
  const sel = params.sel ?? rows[0]?.id ?? null
  const idx = rows.findIndex((r) => r.id === sel)

  if (me.data && !me.data.can.verify)
    return (
      <NoPermission message="Evidence review is for verifiers. Ask Samantha (system owner) if you think you should." />
    )

  const go = (id: string | null) => set({ sel: id ?? undefined })
  const eligible = rows.filter((r) => r.badge !== "Failed")

  return (
    <div className="flex flex-col gap-4 lg:-my-6 lg:-ml-7 lg:min-h-screen lg:flex-row lg:items-stretch lg:gap-0">
      <section
        aria-label="Queue"
        className="flex flex-col rounded-[10px] border border-divider bg-surface lg:sticky lg:top-0 lg:h-screen lg:w-[320px] lg:shrink-0 lg:rounded-none lg:border-y-0 lg:border-l-0"
      >
        <div className="px-3.5 pt-[18px]">
          <h1 className="m-0 mb-0.5 text-[18px] font-semibold">Evidence review</h1>
          <p className="m-0 mb-2 text-[12px] text-muted-foreground">
            Life-safety certificates always; everything else as a 1 in 10 weekly spot-check.
          </p>
          <LineTabs
            size="sm"
            label="Queue"
            value={queue}
            onChange={(k) => set({ queue: k === "needs_review" ? undefined : k, sel: undefined })}
            tabs={(
              list.data?.queues ?? [
                { key: "needs_review", label: "Needs review", count: 0 },
                { key: "spot_check", label: "Spot-check", count: 0 },
                { key: "back_filed", label: "Back-filed", count: 0 },
              ]
            ).map((q) => ({ ...q, count: list.data ? q.count : null }))}
          />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {list.error ? (
            <ErrorState onRetry={() => void list.refetch()} />
          ) : !list.data ? (
            <div className="flex flex-col gap-2 p-3.5">
              {[0, 1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-16" />
              ))}
            </div>
          ) : rows.length === 0 ? (
            <EmptyState icon={<Inbox className="size-6" />} title="Nothing to review">
              {queue === "needs_review"
                ? "Every submitted check has been reviewed. New ones arrive here as staff send them."
                : queue === "spot_check"
                  ? "No spot-checks picked this week."
                  : "No back-filed paper records waiting."}
            </EmptyState>
          ) : (
            rows.map((r) => <QueueRow key={r.id} r={r} on={r.id === sel} onPick={() => go(r.id)} />)
          )}
        </div>
        {eligible.length > 1 && (
          <div className="border-t border-divider px-3.5 py-2.5">
            <Button variant="outline" size="sm" className="w-full" onClick={() => setBulk(true)}>
              Approve {eligible.length} checks…
            </Button>
          </div>
        )}
        <div className="flex items-start gap-2 border-t border-divider p-3.5 text-muted-foreground">
          <EyeOff aria-hidden className="mt-0.5 size-4 shrink-0" />
          <span className="text-[12px]">Your own submissions never appear here. They route to another verifier.</span>
        </div>
      </section>

      <main className="flex min-w-0 flex-1 flex-col gap-4 lg:px-7 lg:pt-5 lg:pb-7">
        {sel ? (
          <Submission
            key={sel}
            id={sel}
            pos={idx >= 0 ? { i: idx, n: rows.length } : null}
            onPrev={idx > 0 ? () => go(rows[idx - 1].id) : undefined}
            onNext={idx >= 0 && idx < rows.length - 1 ? () => go(rows[idx + 1].id) : undefined}
            onDecided={(label) => {
              const next = rows[idx + 1] ?? rows[idx - 1] ?? null
              const done = sel
              void qc.invalidateQueries({ queryKey: ["reviews"] })
              void qc.invalidateQueries({ queryKey: ["nav"] })
              go(next && next.id !== done ? next.id : null)
              toast(label, { action: { label: "Show it", onClick: () => go(done) } })
            }}
          />
        ) : list.data ? (
          <div className="rounded-[10px] border border-divider bg-surface">
            <EmptyState icon={<Check className="size-6" />} title="You're up to date">
              Pick another queue on the left, or come back when staff send more checks.
            </EmptyState>
          </div>
        ) : (
          <Skeleton className="h-[480px]" />
        )}
      </main>

      {bulk && (
        <BulkDialog
          rows={eligible}
          where={property?.name ?? "All properties"}
          onDone={() => setBulk(false)}
          onApproved={() => {
            void qc.invalidateQueries({ queryKey: ["reviews"] })
            void qc.invalidateQueries({ queryKey: ["nav"] })
            set({ sel: undefined })
          }}
        />
      )}
    </div>
  )
}

function QueueRow({ r, on, onPick }: { r: QueueCard; on: boolean; onPick: () => void }) {
  return (
    <button
      type="button"
      aria-current={on || undefined}
      onClick={onPick}
      className={cn(rowCls(on), "flex flex-col gap-1 px-3.5 py-3")}
    >
      <span className="flex items-center gap-1.5">
        <ClassBadge klass={r.class} />
        <span className="mono-id">{r.ref}</span>
        <Pill tone={r.badge_tone} className="ml-auto">
          {r.badge}
        </Pill>
      </span>
      <span className="font-medium">{r.title}</span>
      <span className="text-[12px] text-muted-foreground">{r.detail}</span>
    </button>
  )
}

function answerValue(a: { value: string; failed: boolean }) {
  const v = a.value
  if (["Yes", "Pass", "True"].includes(v))
    return <Pill tone={a.failed ? "red" : "green"}>{v === "True" ? "Yes" : v}</Pill>
  if (["No", "Fail", "False"].includes(v))
    return <Pill tone={a.failed ? "red" : "grey"}>{v === "False" ? "No" : v}</Pill>
  if (v === "None") return <span className="text-muted-foreground">None</span>
  return <span className={cn("font-medium", a.failed && "text-st-red")}>{v}</span>
}

function Submission({
  id,
  pos,
  onPrev,
  onNext,
  onDecided,
}: {
  id: string
  pos: { i: number; n: number } | null
  onPrev?: () => void
  onNext?: () => void
  onDecided: (label: string) => void
}) {
  const qc = useQueryClient()
  const res = useQuery<ReviewDetail, ApiError>({
    queryKey: ["review", id],
    queryFn: () => api.get<ReviewDetail>(`/api/reviews/${id}`),
  })
  const [comment, setComment] = React.useState("")
  const [needComment, setNeedComment] = React.useState(false)
  const [amending, setAmending] = React.useState(false)
  const commentRef = React.useRef<HTMLInputElement>(null)
  const s = res.data
  const locked = !!s && s.verifications.length > 0
  const canAct = !!s && s.can_verify && !locked

  const verify = useMutation({
    mutationFn: (result: "approved" | "rejected" | "needs_action") =>
      api.post(`/api/reviews/${id}/verify`, { result, comment: comment.trim() || null }),
    onSuccess: (_d, result) => {
      void qc.invalidateQueries({ queryKey: ["review", id] })
      const what = {
        approved: "Approved. Marked Verified and locked.",
        rejected: "Rejected. The task is open again for a redo.",
        needs_action: "Needs action. An Action was raised.",
      }[result]
      onDecided(`${s?.ref ?? ""} ${what}`.trim())
    },
    onError: (e: ApiError) => toastError(e.message),
  })

  const act = React.useCallback(
    (result: "approved" | "rejected" | "needs_action") => {
      if (result === "rejected" && !comment.trim()) {
        setNeedComment(true)
        commentRef.current?.focus()
        return
      }
      verify.mutate(result)
    },
    [comment, verify],
  )

  React.useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (isTyping(e) || e.metaKey || e.ctrlKey || e.altKey) return
      if (e.key === "a" && canAct && !verify.isPending) {
        e.preventDefault()
        act("approved")
      } else if (e.key === "j" && onNext) onNext()
      else if (e.key === "k" && onPrev) onPrev()
    }
    window.addEventListener("keydown", h)
    return () => window.removeEventListener("keydown", h)
  }, [act, canAct, verify.isPending, onNext, onPrev])

  if (res.error)
    return (
      <div className="rounded-[10px] border border-divider bg-surface">
        <ErrorState
          title={res.error.status === 404 ? "This submission wasn't found" : undefined}
          onRetry={res.error.status === 404 ? undefined : () => void res.refetch()}
        />
      </div>
    )
  if (!s)
    return (
      <div className="flex flex-col gap-4" aria-busy="true" aria-label="Loading submission">
        <Skeleton className="h-16 w-2/3" />
        <div className="grid gap-4 md:grid-cols-2">
          <Skeleton className="h-72" />
          <Skeleton className="h-72" />
        </div>
      </div>
    )

  const st = STATUS[s.status] ?? { tone: "grey" as Tone, label: s.status }
  const camera = s.photos.length > 0 && s.photos.every((p) => p.captured_with === "camera")
  const v = s.verifications[s.verifications.length - 1]

  return (
    <>
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <ClassBadge klass={s.class} />
            <span className="mono-id text-[12px]">{s.ref}</span>
            <Pill tone={st.tone}>{st.label}</Pill>
            <Pill tone="grey">{s.verification_rule}</Pill>
            {s.flags.map((f) => (
              <FlagBadge key={f} flag={f} />
            ))}
          </div>
          <h2 className="m-0 mt-1.5 text-[18px] font-semibold">{s.title}</h2>
          <p className="m-0 mt-0.5 text-muted-foreground">{s.subtitle}</p>
        </div>
        <div className="flex items-center gap-2">
          {pos && (
            <span className="tabular text-[12.5px] text-muted-foreground">
              {pos.i + 1} of {pos.n}
            </span>
          )}
          <Button variant="outline" size="icon" aria-label="Previous submission" disabled={!onPrev} onClick={onPrev}>
            <ChevronLeft />
          </Button>
          <Button variant="outline" size="icon" aria-label="Next submission" disabled={!onNext} onClick={onNext}>
            <ChevronRight />
          </Button>
        </div>
      </header>

      <div className="grid grid-cols-[repeat(auto-fit,minmax(300px,1fr))] gap-4">
        <div className="flex flex-col gap-3 rounded-[10px] border border-divider bg-surface p-3.5">
          <div className="flex justify-between gap-2">
            <span className="font-semibold">
              Evidence · {s.photo_count} {s.photo_count === 1 ? "photo" : "photos"}
            </span>
            {s.photos.length > 0 && (
              <span className="text-[12px] text-muted-foreground">
                {camera ? "In-app camera only" : "Includes uploaded files"}
              </span>
            )}
          </div>
          {s.photos.length === 0 ? (
            <div className="rounded-lg bg-hover px-4 py-10 text-center text-[13px] text-muted-foreground">
              No photos with this check.
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-2.5">
              {s.photos.map((p, i) => (
                <figure key={p.id} className="m-0">
                  <a
                    href={p.url}
                    target="_blank"
                    rel="noreferrer"
                    className="relative block h-[210px] overflow-hidden rounded-lg bg-hover"
                  >
                    {p.content_type.startsWith("image/") ? (
                      <img
                        src={p.url}
                        alt={`Photo ${i + 1}: ${p.required ?? p.file_name}`}
                        className="size-full object-cover"
                      />
                    ) : (
                      <span className="flex size-full items-center justify-center p-4 text-center text-[13px] text-st-grey">
                        {p.file_name}
                      </span>
                    )}
                    <span className="absolute inset-x-2 bottom-2 rounded-[5px] bg-black/80 px-2 py-[5px] text-left font-mono text-[10.5px] text-white">
                      {p.stamp}
                      {p.taken && (
                        <>
                          <br />
                          {p.taken}
                        </>
                      )}
                    </span>
                  </a>
                  {p.required && (
                    <figcaption className="mt-1 text-[12px] text-muted-foreground">
                      Required: {p.required.toLowerCase()}
                    </figcaption>
                  )}
                </figure>
              ))}
            </div>
          )}
          <div className="flex flex-wrap gap-1.5">
            {s.original_kept && <Pill tone="green">Original kept, unaltered</Pill>}
            {s.duplicate_found ? (
              <Pill tone="amber">Photo used before</Pill>
            ) : (
              <Pill tone="grey">No duplicate found</Pill>
            )}
          </div>
        </div>

        <div className="flex flex-col gap-2.5 rounded-[10px] border border-divider bg-surface p-3.5">
          <span className="font-semibold">Answers</span>
          <dl className="m-0 grid grid-cols-[1fr_auto] items-center gap-y-2">
            {s.answers.map((a) => (
              <React.Fragment key={a.label}>
                <dt className={cn(a.failed && "text-st-red")}>{a.label}</dt>
                <dd className="m-0 text-right">{answerValue(a)}</dd>
              </React.Fragment>
            ))}
            {s.notes && (
              <>
                <dt>Notes</dt>
                <dd className="m-0 text-right text-muted-foreground">{s.notes}</dd>
              </>
            )}
          </dl>
          <div className="h-px bg-divider" />
          <span className="font-semibold">Proof of presence</span>
          <dl className="m-0 grid grid-cols-[120px_1fr] gap-y-1.5 text-[12.5px]">
            <dt className="text-muted-foreground">Submitted by</dt>
            <dd className="m-0">{s.presence.submitted_by}</dd>
            <dt className="text-muted-foreground">Work done</dt>
            <dd className="m-0">{s.presence.work_done}</dd>
            <dt className="text-muted-foreground">Server time</dt>
            <dd className="m-0">{s.presence.server_time}</dd>
            <dt className="text-muted-foreground">Device time</dt>
            <dd className="m-0">
              {s.presence.device_time ?? <span className="text-muted-foreground">Not recorded</span>}
            </dd>
            <dt className="text-muted-foreground">Location</dt>
            <dd className="m-0">
              <Pill
                tone={
                  s.presence.location === "Inside geofence"
                    ? "green"
                    : s.presence.location === "Outside geofence"
                      ? "amber"
                      : "grey"
                }
              >
                {s.presence.location}
              </Pill>{" "}
              <span className="text-muted-foreground">read once at submission</span>
            </dd>
            <dt className="text-muted-foreground">Device</dt>
            <dd className="m-0">{s.presence.device}</dd>
            {s.presence.photo_hash && (
              <>
                <dt className="text-muted-foreground">Photo hash</dt>
                <dd className="m-0 font-mono text-[12px] text-subtle">{s.presence.photo_hash}</dd>
              </>
            )}
            {(s.presence.captured_offline || s.presence.back_filed) && (
              <>
                <dt className="text-muted-foreground">Captured</dt>
                <dd className="m-0">
                  {s.presence.back_filed ? "Back-filed from a paper record" : "Offline, sent later"}
                </dd>
              </>
            )}
          </dl>
        </div>
      </div>

      {locked && v ? (
        <Callout
          tone={v.result === "approved" ? "green" : v.result === "rejected" ? "red" : "amber"}
          icon={<Lock className="size-4" />}
        >
          <div className="flex flex-wrap items-center gap-3">
            <span className="flex-1">
              {v.result === "approved"
                ? "Verified"
                : v.result === "rejected"
                  ? "Rejected and reopened"
                  : "Needs action"}{" "}
              by {v.by}, {fmtDateTime(v.at)}
              {v.comment ? `: “${v.comment}”.` : "."} The record is locked.
            </span>
            {s.can_amend && (
              <Button variant="outline" size="sm" onClick={() => setAmending(true)}>
                Add a correction
              </Button>
            )}
          </div>
        </Callout>
      ) : s.own ? (
        <Callout tone="grey">You sent this check, so someone else must verify it.</Callout>
      ) : null}

      {s.amendments.length > 0 && (
        <section aria-label="Corrections" className="rounded-[10px] border border-divider bg-surface p-3.5 text-[13px]">
          <div className="mb-1.5 font-semibold">Corrections</div>
          {s.amendments.map((a, i) => (
            <div key={i} className="border-t border-divider py-1.5 first:border-0">
              <span className="text-muted-foreground">
                {a.by} · {fmtDateTime(a.at)} · {REASONS.find((r) => r.value === a.reason_type)?.label ?? a.reason_type}
              </span>
              <div>{a.reason}</div>
            </div>
          ))}
        </section>
      )}

      {!locked && (
        <>
          <div className="flex flex-wrap items-center gap-3 rounded-[10px] border border-divider bg-surface p-3.5">
            <label className="flex min-w-0 flex-[1_1_320px] flex-col gap-[5px]">
              <span className="text-[12px] font-medium text-ink2">
                Comment <span className="font-normal text-muted-foreground">(required to reject)</span>
              </span>
              <input
                ref={commentRef}
                value={comment}
                disabled={!canAct}
                aria-invalid={needComment && !comment.trim()}
                onChange={(e) => {
                  setComment(e.target.value)
                  setNeedComment(false)
                }}
                placeholder="e.g. Log book photo is blurred, retake it"
                className={cn(
                  "h-8 rounded-md border border-border bg-surface px-2.5 text-[13px] outline-none placeholder:text-muted-foreground focus-visible:outline-2 focus-visible:outline-focus",
                  needComment && !comment.trim() && "border-st-red",
                )}
              />
              {needComment && !comment.trim() && (
                <span role="alert" className="text-[12px] text-st-red">
                  Say what needs redoing, so the person knows what to fix.
                </span>
              )}
            </label>
            <div className="flex gap-2 self-end">
              <Button
                variant="outline"
                className="border-st-red/30 text-st-red"
                disabled={!canAct || verify.isPending}
                onClick={() => act("rejected")}
              >
                Reject and reopen
              </Button>
              <Button variant="outline" disabled={!canAct || verify.isPending} onClick={() => act("needs_action")}>
                Needs action
              </Button>
              <Button disabled={!canAct || verify.isPending} onClick={() => act("approved")}>
                <Check />
                Approve
                <kbd className="ml-0.5 inline-flex h-[18px] items-center rounded border border-white/20 bg-white/10 px-1 font-sans text-[11px] text-primary-foreground/80">
                  A
                </kbd>
              </Button>
            </div>
          </div>
          <p className="m-0 text-[12px] text-muted-foreground">
            Reject reopens the task for a redo with your reason. Needs action raises an Action. Approve marks it
            Verified and locks the record. Corrections after that are amendments with a reason.
          </p>
        </>
      )}

      {amending && <AmendDialog s={s} onDone={() => setAmending(false)} />}
    </>
  )
}

const REASONS = [
  { value: "typing_mistake", label: "Typing mistake" },
  { value: "wrong_item", label: "Wrong item or location recorded" },
  { value: "wrong_time", label: "Wrong date or time" },
  { value: "late_information", label: "Information arrived later" },
  { value: "other", label: "Something else" },
]

function AmendDialog({ s, onDone }: { s: ReviewDetail; onDone: () => void }) {
  const qc = useQueryClient()
  const [what, setWhat] = React.useState("")
  const [why, setWhy] = React.useState(REASONS[0].value)
  const save = useMutation({
    mutationFn: () =>
      api.post(`/api/reviews/${s.id}/amend`, {
        reason_type: why,
        reason: what.trim(),
        changes: { correction: what.trim() },
      }),
    onSuccess: () => {
      toast("Correction added")
      void qc.invalidateQueries({ queryKey: ["review", s.id] })
      onDone()
    },
    onError: (e: ApiError) => toastError(e.message),
  })
  return (
    <QDialog
      open
      onOpenChange={(o) => !o && onDone()}
      busy={save.isPending}
      title="Add a correction"
      sub={`${s.title.split(",")[0]} · ${s.presence.work_done}, ${s.presence.server_time.slice(0, 5)} · locked`}
      footer={
        <>
          <Button variant="outline" onClick={onDone}>
            Cancel
          </Button>
          <Button disabled={!what.trim() || save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? "Adding…" : "Add correction"}
          </Button>
        </>
      }
    >
      <Field label="What was wrong?">
        <textarea
          autoFocus
          rows={3}
          value={what}
          onChange={(e) => setWhat(e.target.value)}
          placeholder="e.g. Wrong call point recorded. It was CP4, not CP3."
          className={textareaCls}
        />
      </Field>
      <Field label="Why are you changing it?">
        <select value={why} onChange={(e) => setWhy(e.target.value)} className={inputCls}>
          {REASONS.map((r) => (
            <option key={r.value} value={r.value}>
              {r.label}
            </option>
          ))}
        </select>
      </Field>
      <Note>
        The original stays in the record. Your correction is added underneath with your name and the time, and shows in
        the audit log.
      </Note>
    </QDialog>
  )
}

function BulkDialog({
  rows,
  where,
  onDone,
  onApproved,
}: {
  rows: QueueCard[]
  where: string
  onDone: () => void
  onApproved: () => void
}) {
  const n = rows.length
  const ls = rows.filter((r) => r.class === "A").length
  const rest = n - ls
  const [all, setAll] = React.useState(true)
  const count = all ? n : rest
  const go = useMutation({
    mutationFn: () =>
      api.post<{ approved: number; left_for_review: number }>("/api/reviews/bulk-approve", {
        ids: rows.map((r) => r.id),
        include_life_safety: all,
      }),
    onSuccess: (r) => {
      toast(
        `${r.approved} ${r.approved === 1 ? "check" : "checks"} approved` +
          (r.left_for_review
            ? `. ${r.left_for_review} life-safety ${r.left_for_review === 1 ? "check is" : "checks are"} left to review one by one.`
            : ""),
      )
      onApproved()
      onDone()
    },
    onError: (e: ApiError) => toastError(e.message),
  })
  return (
    <QDialog
      open
      onOpenChange={(o) => !o && onDone()}
      busy={go.isPending}
      title={`Approve ${n} checks?`}
      sub={`Evidence review · ${where}`}
      footer={
        <>
          <Button variant="outline" onClick={onDone}>
            Cancel
          </Button>
          <Button disabled={go.isPending || count === 0} onClick={() => go.mutate()}>
            {go.isPending ? "Approving…" : `Approve ${count} ${count === 1 ? "check" : "checks"}`}
          </Button>
        </>
      }
    >
      <div role="radiogroup" aria-label="What to approve" className="flex flex-col gap-2">
        <Radio on={all} onPick={() => setAll(true)} title={`Approve all ${n}`} sub="I've looked at every photo" />
        {ls > 0 && rest > 0 && (
          <Radio
            on={!all}
            onPick={() => setAll(false)}
            title={`Approve ${rest}, review ${ls} one by one`}
            sub={`The ${ls} life-safety ${ls === 1 ? "check opens" : "checks open"} separately`}
          />
        )}
      </div>
      <span className="text-[13px] text-muted-foreground">
        Your name goes on each approval. Failed checks aren't included; open those one by one.
      </span>
    </QDialog>
  )
}
