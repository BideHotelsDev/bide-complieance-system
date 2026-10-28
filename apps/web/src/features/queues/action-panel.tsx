/*
 * The selected Action, beside the list (design: Actions to fix › Selected item). Actions close only with closing
 * evidence; Advisories close with a recorded decision and reason. If the server refuses, the "can't be closed yet"
 * dialog explains what proof is missing (design: Dialogs).
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import * as React from "react"
import { AlertTriangle, FileText, Phone, X } from "lucide-react"

import { api, ApiError, upload } from "@bide-comply/api-client"
import { Button } from "@bide-comply/ui/components/button"
import { ErrorState, Skeleton } from "@bide-comply/ui/components/page"
import { Pill, PriorityBadge } from "@bide-comply/ui/components/status"
import { toast, toastError } from "@bide-comply/ui/components/toaster"
import { cn } from "@bide-comply/ui/lib/utils"

import { fmtDate, fmtDateTime } from "@/lib/format"
import { useMe } from "@/lib/session"
import type { ActionDetail } from "./types"
import { ownerBody, ownerLabel, OwnerSelect, useOwnerOptions } from "./owner-select"
import { DropZone, Field, inputCls, QDialog, textareaCls } from "./ui"

export function ActionPanel({ ref_, onClose, onClosed }: { ref_: string; onClose: () => void; onClosed: () => void }) {
  const qc = useQueryClient()
  const me = useMe()
  const res = useQuery<ActionDetail, ApiError>({
    queryKey: ["action", ref_],
    queryFn: () => api.get<ActionDetail>(`/api/actions/${ref_}`),
  })
  const a = res.data
  const [decision, setDecision] = React.useState("")
  const [reason, setReason] = React.useState("")
  const [refused, setRefused] = React.useState<string | null>(null)
  const [reassign, setReassign] = React.useState(false)
  const [commenting, setCommenting] = React.useState(false)
  const [comment, setComment] = React.useState("")
  const [uploading, setUploading] = React.useState(false)
  const fileRef = React.useRef<HTMLInputElement>(null)
  const decisionRef = React.useRef<HTMLTextAreaElement>(null)

  React.useEffect(() => {
    setDecision(a?.decision ?? "")
    setReason(a?.decision_reason ?? "")
    setCommenting(false)
    setComment("")
  }, [a?.ref, a?.decision, a?.decision_reason])

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["action", ref_] })
    void qc.invalidateQueries({ queryKey: ["actions"] })
  }

  const isAdv = a?.type === "advisory"
  const closing = (a?.evidence ?? []).filter((e) => e.purpose === "closing")
  const ready = a ? (isAdv ? !!decision.trim() && !!reason.trim() : closing.length > 0) : false

  const close = useMutation({
    mutationFn: () =>
      api.post(
        `/api/actions/${ref_}/close`,
        isAdv ? { decision: decision.trim(), decision_reason: reason.trim() } : {},
      ),
    onSuccess: () => {
      // Undo instead of "Are you sure?" (design: Dialogs › small confirmations).
      toast(`${ref_} closed`, {
        action: {
          label: "Undo",
          onClick: () =>
            void api
              .post(`/api/actions/${ref_}/reopen`, {})
              .then(() => {
                toast(`${ref_} is open again`)
                refresh()
                void qc.invalidateQueries({ queryKey: ["nav"] })
              })
              .catch((e: ApiError) => toastError(e.message)),
        },
      })
      refresh()
      void qc.invalidateQueries({ queryKey: ["nav"] })
      onClosed()
    },
    onError: (e: ApiError) => {
      if (e.code === "needs_evidence") setRefused(e.message)
      else toastError(e.message)
    },
  })

  const reopen = useMutation({
    mutationFn: () => api.post(`/api/actions/${ref_}/reopen`, {}),
    onSuccess: () => {
      toast(`${ref_} is open again`)
      refresh()
      void qc.invalidateQueries({ queryKey: ["nav"] })
    },
    onError: (e: ApiError) => toastError(e.message),
  })

  const addFiles = async (files: File[]) => {
    if (!a) return
    setUploading(true)
    try {
      const ids: string[] = []
      for (const f of files) {
        const up = await upload(f, { captured_with: "upload", property_id: a.property_id, file_name: f.name })
        ids.push(up.id)
      }
      await api.post(`/api/actions/${ref_}/evidence`, { evidence_ids: ids })
      toast(files.length === 1 ? "Closing evidence filed" : `${files.length} files filed as closing evidence`)
      refresh()
    } catch (e) {
      toastError(e instanceof ApiError ? e.message : "The upload didn't finish. Try again.")
    } finally {
      setUploading(false)
    }
  }

  const sendComment = useMutation({
    mutationFn: () => api.post(`/api/actions/${ref_}/comments`, { body: comment }),
    onSuccess: () => {
      toast("Comment added")
      setComment("")
      setCommenting(false)
      refresh()
    },
    onError: (e: ApiError) => toastError(e.message),
  })

  const callMade = useMutation({
    mutationFn: () => api.post(`/api/actions/${ref_}/call-made`, { note: "Call made" }),
    onSuccess: () => {
      toast("Phone call recorded")
      refresh()
    },
    onError: (e: ApiError) => toastError(e.message),
  })

  const canReassign = !!(me.data?.can["action.manage"] || me.data?.can.assign)

  return (
    <aside
      aria-label="Selected item"
      className="flex w-full flex-col rounded-[10px] border border-divider bg-surface lg:sticky lg:top-0 lg:-my-6 lg:-mr-7 lg:h-screen lg:w-[400px] lg:shrink-0 lg:overflow-y-auto lg:rounded-none lg:border-y-0 lg:border-r-0"
    >
      <div className="flex items-center gap-2 border-b border-divider px-[18px] py-3.5">
        {a ? (
          <>
            <span className="mono-id text-[12px]">{a.ref}</span>
            <PriorityBadge priority={a.priority} />
            <Pill tone="grey">{a.type_label}</Pill>
            {a.status === "closed" && <Pill tone="green">Closed</Pill>}
            {a.status !== "closed" && a.contractor_fix?.status === "pending" && (
              <Pill tone="blue">Awaiting verification</Pill>
            )}
          </>
        ) : (
          <Skeleton className="h-5 w-40" />
        )}
        <button
          type="button"
          aria-label="Close panel"
          onClick={onClose}
          className="ml-auto rounded-md p-1.5 hover:bg-hover"
        >
          <X className="size-4" />
        </button>
      </div>
      {res.error ? (
        <ErrorState
          title={res.error.status === 404 ? "This Action wasn't found" : undefined}
          message={res.error.status === 404 ? "It may have a different ID, or you can't see that property." : undefined}
          onRetry={res.error.status === 404 ? undefined : () => void res.refetch()}
        />
      ) : !a ? (
        <div className="flex flex-col gap-3 p-[18px]">
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-40 w-full" />
        </div>
      ) : (
        <div className="flex flex-col gap-4 p-[18px]">
          <h2 className="m-0 text-[16px] leading-[1.35] font-semibold">{a.description}</h2>
          {a.call_due && !a.call_made_at && (
            <div
              role="alert"
              className="flex flex-col gap-2 rounded-[10px] border border-st-red/25 bg-st-red-bg px-3.5 py-3 text-st-red"
            >
              <span className="flex items-start gap-2 font-medium">
                <Phone aria-hidden className="mt-0.5 size-4 shrink-0" />
                Life-safety failure: phone the person responsible now, then record that you called.
              </span>
              <Button
                size="sm"
                variant="outline"
                className="self-start"
                disabled={callMade.isPending}
                onClick={() => callMade.mutate()}
              >
                I've made the call
              </Button>
            </div>
          )}
          {a.status !== "closed" && a.contractor_fix?.status === "pending" && (
            <div
              role="note"
              className="flex flex-col gap-1.5 rounded-[10px] border border-st-blue/25 bg-st-blue-bg px-3.5 py-3 text-st-blue"
            >
              <span className="font-medium">
                {a.contractor_fix.contractor} marked this fixed on {a.contractor_fix.sent_on}. It stays open until
                someone checks their photo.
              </span>
              {a.contractor_fix.note && <span className="text-[13px]">"{a.contractor_fix.note}"</span>}
              <Link
                to="/reviews"
                search={{ queue: "contractor", sel: a.contractor_fix.upload_id }}
                className="self-start text-[13px] font-medium text-link"
              >
                Check it in Evidence review
              </Link>
            </div>
          )}
          {a.status !== "closed" && a.contractor_fix?.status === "rejected" && (
            <p role="note" className="m-0 rounded-[10px] bg-st-amber-bg px-3.5 py-3 text-[13px] text-st-amber">
              Fix sent back to {a.contractor_fix.contractor}: {a.contractor_fix.review_comment}
            </p>
          )}
          <dl className="m-0 grid grid-cols-[110px_1fr] gap-y-2 text-[14px]">
            <dt className="text-muted-foreground">Property</dt>
            <dd className="m-0">
              <Link to="/properties/$code" params={{ code: a.property_code }} className="text-link">
                {a.property}
              </Link>
            </dd>
            <dt className="text-muted-foreground">Source</dt>
            <dd className="m-0">
              {a.submission_id ? (
                <Link to="/reviews" search={{ sel: a.submission_id }} className="text-link">
                  {a.source_label}
                </Link>
              ) : a.certificate_id ? (
                <Link to="/certificates" search={{ sel: a.certificate_id }} className="text-link">
                  {a.source_label}
                </Link>
              ) : (
                a.source_label
              )}
            </dd>
            <dt className="text-muted-foreground">Gate ref</dt>
            <dd className="m-0 font-mono text-[12px]">
              {a.gate_ref ? (
                <Link
                  to="/gates/$code"
                  params={{ code: a.property_code }}
                  search={{ item: a.gate_ref }}
                  className="text-link"
                >
                  {a.gate_ref}
                </Link>
              ) : (
                <span className="font-sans text-muted-foreground">None</span>
              )}
            </dd>
            {a.item_ref && (
              <>
                <dt className="text-muted-foreground">Register item</dt>
                <dd className="m-0 font-mono text-[12px]">
                  <Link
                    to="/properties/$code"
                    params={{ code: a.property_code }}
                    search={{ item: a.item_ref }}
                    className="text-link"
                  >
                    {a.item_ref}
                  </Link>
                </dd>
              </>
            )}
            <dt className="text-muted-foreground">Owner</dt>
            <dd className="m-0">{a.owner ?? <span className="text-st-amber">Nobody yet</span>}</dd>
            <dt className="text-muted-foreground">Raised</dt>
            <dd className="m-0">{fmtDate(a.raised_on)}</dd>
            <dt className="text-muted-foreground">Due</dt>
            <dd className={cn("m-0", a.late && "text-st-red")}>
              {fmtDate(a.due_on)} · {a.left}
            </dd>
            <dt className="text-muted-foreground">Window</dt>
            <dd className="m-0">{a.window}</dd>
            {a.interim_measure && (
              <>
                <dt className="text-muted-foreground">Interim measure</dt>
                <dd className="m-0">{a.interim_measure}</dd>
              </>
            )}
            {a.call_made_at && (
              <>
                <dt className="text-muted-foreground">Call made</dt>
                <dd className="m-0">{fmtDateTime(a.call_made_at)}</dd>
              </>
            )}
            {a.status === "closed" && (
              <>
                <dt className="text-muted-foreground">Closed</dt>
                <dd className="m-0">{fmtDate(a.closed_on)}</dd>
              </>
            )}
          </dl>

          {isAdv ? (
            <div className="flex flex-col gap-2">
              <span className="font-semibold">Record the decision to close</span>
              <Field label="Decision">
                <textarea
                  ref={decisionRef}
                  rows={3}
                  value={decision}
                  onChange={(e) => setDecision(e.target.value)}
                  placeholder="What was decided, by whom"
                  disabled={a.status === "closed"}
                  className={cn(textareaCls, "rounded-md text-[13px]")}
                />
              </Field>
              <Field label="Reason, and where it is recorded (e.g. FRA section)">
                <textarea
                  rows={2}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  disabled={a.status === "closed"}
                  className={cn(textareaCls, "rounded-md text-[13px]")}
                />
              </Field>
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              <span className="font-semibold">Closing evidence</span>
              {closing.length > 0 && (
                <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
                  {closing.map((e) => (
                    <li
                      key={e.id}
                      className="flex items-center gap-2 rounded-md border border-divider px-2.5 py-1.5 text-[13px]"
                    >
                      {e.thumb_url ? (
                        <img src={e.thumb_url} alt="" className="size-8 shrink-0 rounded object-cover" />
                      ) : (
                        <FileText aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                      )}
                      <a href={e.url} target="_blank" rel="noreferrer" className="min-w-0 flex-1 truncate">
                        {e.file_name}
                      </a>
                    </li>
                  ))}
                </ul>
              )}
              {a.status !== "closed" && (
                <DropZone
                  busy={uploading}
                  onFiles={(f) => void addFiles(f)}
                  sub={'Named automatically "What - Who - Date"'}
                />
              )}
              <input
                ref={fileRef}
                type="file"
                multiple
                accept="image/*,application/pdf"
                className="sr-only"
                tabIndex={-1}
                aria-hidden
                onChange={(e) => {
                  const f = Array.from(e.target.files ?? [])
                  e.target.value = ""
                  if (f.length) void addFiles(f)
                }}
              />
            </div>
          )}

          {a.status !== "closed" && (
            <>
              <div className="flex flex-wrap gap-2">
                {a.can_close && (
                  <Button
                    aria-disabled={!ready}
                    disabled={close.isPending}
                    onClick={() => close.mutate()}
                    className={cn(!ready && "cursor-not-allowed opacity-45 hover:opacity-45")}
                  >
                    {close.isPending ? "Closing…" : a.close_label}
                  </Button>
                )}
                {canReassign && (
                  <Button variant="outline" onClick={() => setReassign(true)}>
                    Reassign
                  </Button>
                )}
                <Button variant="outline" onClick={() => setCommenting((c) => !c)} aria-expanded={commenting}>
                  Comment
                </Button>
              </div>
              <p className="m-0 text-[12px] text-muted-foreground">{a.close_hint}</p>
            </>
          )}

          {a.status === "closed" && a.can_reopen && (
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="outline" disabled={reopen.isPending} onClick={() => reopen.mutate()}>
                Undo close
              </Button>
              <span className="text-[12px] text-muted-foreground">You closed this today, so you can undo it.</span>
            </div>
          )}

          {commenting && (
            <form
              className="flex flex-col gap-2"
              onSubmit={(e) => {
                e.preventDefault()
                if (comment.trim()) sendComment.mutate()
              }}
            >
              <Field label="Comment">
                <textarea
                  autoFocus
                  rows={3}
                  value={comment}
                  onChange={(e) => setComment(e.target.value)}
                  placeholder="Visible to everyone who can see this Action"
                  className={cn(textareaCls, "rounded-md text-[13px]")}
                />
              </Field>
              <div className="flex gap-2">
                <Button type="submit" size="sm" disabled={!comment.trim() || sendComment.isPending}>
                  Add comment
                </Button>
                <Button type="button" size="sm" variant="ghost" onClick={() => setCommenting(false)}>
                  Cancel
                </Button>
              </div>
            </form>
          )}

          {a.comments.length > 0 && (
            <section aria-label="Comments" className="flex flex-col gap-2 border-t border-divider pt-3">
              <span className="text-[13px] font-semibold">Comments</span>
              {a.comments.map((c) => (
                <div key={c.id} className="text-[13px]">
                  <div className="text-[12px] text-muted-foreground">
                    {c.author} · {fmtDateTime(c.at)}
                  </div>
                  <div className="whitespace-pre-wrap">{c.body}</div>
                </div>
              ))}
            </section>
          )}
        </div>
      )}

      {a && (
        <CantCloseDialog
          open={!!refused}
          onOpenChange={(o) => !o && setRefused(null)}
          action={a}
          message={refused ?? ""}
          onProof={() => {
            setRefused(null)
            if (isAdv) setTimeout(() => decisionRef.current?.focus(), 50)
            else fileRef.current?.click()
          }}
        />
      )}
      {a && reassign && <ReassignDialog action={a} onDone={() => setReassign(false)} onSaved={refresh} />}
    </aside>
  )
}

function short(s: string, n = 60) {
  const first = s.split(/[.;:]/)[0]
  return first.length > n ? `${first.slice(0, n - 1)}…` : first
}

function CantCloseDialog({
  open,
  onOpenChange,
  action: a,
  message,
  onProof,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  action: ActionDetail
  message: string
  onProof: () => void
}) {
  const adv = a.type === "advisory"
  const lead = adv
    ? "An Advisory needs a recorded decision before it closes:"
    : a.priority === "high"
      ? "An urgent action needs proof that it's fixed:"
      : "This Action needs proof that it's fixed:"
  const needs = adv
    ? ["What was decided, and by whom", "The reason, and where it is recorded (for example the FRA section)"]
    : a.class === "A" || a.source === "failed_check"
      ? ["A photo that shows it is fixed", "The contractor's job sheet or a test result"]
      : ["A photo, scan or certificate that shows it is done", "Or the contractor's job sheet"]
  return (
    <QDialog
      open={open}
      onOpenChange={onOpenChange}
      alert
      title="This Action can't be closed yet"
      sub={`${short(a.description)} · ${a.property} · ${a.priority_label}`}
      footer={
        <>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Not now
          </Button>
          <Button onClick={onProof}>{adv ? "Record the decision" : "Add proof"}</Button>
        </>
      }
    >
      <div className="flex items-start gap-2.5 rounded-[10px] border border-st-red/20 bg-st-red-bg px-3.5 py-3 text-st-red">
        <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0" />
        <span>{lead}</span>
      </div>
      <ul className="m-0 flex flex-col gap-1 pl-[18px]">
        {needs.map((n) => (
          <li key={n}>{n}</li>
        ))}
      </ul>
      {message && <p className="m-0 text-[12.5px] text-muted-foreground">{message}</p>}
    </QDialog>
  )
}

function ReassignDialog({
  action: a,
  onDone,
  onSaved,
}: {
  action: ActionDetail
  onDone: () => void
  onSaved: () => void
}) {
  const opts = useOwnerOptions(a.property_id)
  const current = a.owner_contractor_id ? `c:${a.owner_contractor_id}` : a.owner_id ? `p:${a.owner_id}` : ""
  const [owner, setOwner] = React.useState(current)
  const [due, setDue] = React.useState(a.due_on)
  const [prio, setPrio] = React.useState<string>(a.priority)
  const ownerChanged = !!owner && owner !== current
  const save = useMutation({
    mutationFn: () =>
      api.patch(`/api/actions/${a.ref}`, {
        ...(ownerChanged ? ownerBody(owner) : { owner_id: null, owner_contractor_id: null }),
        due_on: due !== a.due_on ? due : null,
        priority: prio !== a.priority ? prio : null,
      }),
    onSuccess: () => {
      const name = ownerLabel(opts.data, owner)
      toast(ownerChanged && name ? `${a.ref} given to ${name}` : `${a.ref} updated`)
      onSaved()
      onDone()
    },
    onError: (e: ApiError) => toastError(e.message),
  })
  const changed = ownerChanged || due !== a.due_on || prio !== a.priority
  return (
    <QDialog
      open
      onOpenChange={(o) => !o && onDone()}
      busy={save.isPending}
      title={`Reassign ${a.ref}`}
      sub={`${short(a.description)} · ${a.property}`}
      footer={
        <>
          <Button variant="outline" onClick={onDone}>
            Cancel
          </Button>
          <Button disabled={!changed || save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? "Saving…" : "Reassign"}
          </Button>
        </>
      }
    >
      <Field label="Who owns it?" hint="(a person, or a contractor)">
        <OwnerSelect
          value={owner}
          onChange={setOwner}
          options={opts.data}
          empty={a.owner && !a.owner_id && !a.owner_contractor_id ? `${a.owner} (not a named person)` : "Choose"}
        />
      </Field>
      {owner.startsWith("c:") && owner !== current && (
        <span className="text-[13px] text-muted-foreground">
          {ownerLabel(opts.data, owner)} sees it in the contractor portal and marks it fixed with a photo. It closes
          once someone here checks that photo in Evidence review.
        </span>
      )}
      <div className="grid grid-cols-2 gap-2.5">
        <Field label="Due">
          <input type="date" value={due} onChange={(e) => setDue(e.target.value)} className={inputCls} />
        </Field>
        <Field label="Priority">
          <select value={prio} onChange={(e) => setPrio(e.target.value)} className={inputCls}>
            <option value="high">Urgent · 7 days</option>
            <option value="med">Soon · 30 days</option>
            <option value="low">Later · 90 days</option>
          </select>
        </Field>
      </div>
      <span className="text-[13px] text-muted-foreground">The change is recorded in the audit log with your name.</span>
    </QDialog>
  )
}
